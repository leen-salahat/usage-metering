import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { utcPeriodStart } from "../domain/period.js";
import { evaluateConsumption, remaining, type LimitState } from "../domain/quota.js";
import { AppError } from "../errors.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ConsumeInput {
  accountId: string; // always taken from the authenticated API key, never from the body
  userId: string;
  requestId: string;
  units: number;
}

/** What one level (account or user) looked like when the decision was made. */
export interface LevelView {
  planId: string;
  planName: string;
  monthlyAllowance: number;
  maxPerRequest: number;
  consumed: number; // after the decision
  remaining: number; // after the decision
}

export interface ConsumeResult {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  reason: string | null;
  scope: string | null;
  period: string; // YYYY-MM (UTC)
  replayed: boolean; // true when this is a retry of an already-processed request
  account: LevelView;
  user: LevelView;
}

type Snapshot = { account: LevelView; user: LevelView };
type PlanRow = { id: string; name: string; monthly_allowance: string; max_per_request: number };
type ConsumedRow = { consumed: string };
type StoredRequest = {
  user_id: string;
  units: number;
  accepted: boolean;
  reason: string | null;
  scope: string | null;
  period: string;
  applied_limits: Snapshot;
};

function view(plan: PlanRow, consumedAfter: number): LevelView {
  const monthlyAllowance = Number(plan.monthly_allowance);
  return {
    planId: plan.id,
    planName: plan.name,
    monthlyAllowance,
    maxPerRequest: plan.max_per_request,
    consumed: consumedAfter,
    remaining: remaining(monthlyAllowance, consumedAfter),
  };
}

/**
 * Attempts to consume `units` for a user, atomically.
 * Everything below runs in ONE transaction (READ COMMITTED): any failure rolls back
 * the reservation, the counters and the request record together.
 */
export async function consume(db: Db, input: ConsumeInput, now: Date): Promise<ConsumeResult> {
  const { accountId, userId, requestId, units } = input;
  const period = utcPeriodStart(now);

  return db.transaction(async (tx) => {
    // 1) The user must belong to the authenticated account (otherwise: 404, nothing recorded).
    const found = await tx.execute(
      sql`SELECT 1 FROM users WHERE account_id = ${accountId} AND user_id = ${userId}`,
    );
    if (found.rows.length === 0) throw new AppError(404, "USER_NOT_FOUND", "User not found.");

    // 2) Idempotency: reserve the request id. A concurrent duplicate waits here until the
    //    first transaction commits, then gets zero rows back (DO NOTHING).
    const reserved = await tx.execute<{ id: string }>(sql`
      INSERT INTO usage_requests (account_id, request_id, user_id, units, accepted, period_start)
      VALUES (${accountId}, ${requestId}, ${userId}, ${units}, false, ${period})
      ON CONFLICT (account_id, request_id) DO NOTHING
      RETURNING id`);
    if (reserved.rows.length === 0) return replay(tx, input);
    const reservedId = reserved.rows[0].id;

    // 3) Make sure this month's counter rows exist (created lazily, safe if they already exist).
    await tx.execute(sql`
      INSERT INTO account_usage (account_id, period_start, consumed)
      VALUES (${accountId}, ${period}, 0) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO user_usage (account_id, user_id, period_start, consumed)
      VALUES (${accountId}, ${userId}, ${period}, 0) ON CONFLICT DO NOTHING`);

    // 4) Lock the counters in a FIXED order (account, then user) to rule out deadlocks.
    //    Concurrent requests for the same account queue up here and read fresh values.
    const accUsage = await tx.execute<ConsumedRow>(sql`
      SELECT consumed FROM account_usage
      WHERE account_id = ${accountId} AND period_start = ${period} FOR UPDATE`);
    const usrUsage = await tx.execute<ConsumedRow>(sql`
      SELECT consumed FROM user_usage
      WHERE account_id = ${accountId} AND user_id = ${userId} AND period_start = ${period} FOR UPDATE`);

    // 5) Read the CURRENT plans with a shared lock, so a plan update cannot interleave with us.
    const accPlan = await tx.execute<PlanRow>(sql`
      SELECT p.id, p.name, p.monthly_allowance, p.max_per_request
      FROM accounts a JOIN plans p ON p.id = a.plan_id
      WHERE a.id = ${accountId}
      FOR SHARE OF p`);
    const usrPlan = await tx.execute<PlanRow>(sql`
      SELECT p.id, p.name, p.monthly_allowance, p.max_per_request
      FROM users u JOIN plans p ON p.id = u.plan_id
      WHERE u.account_id = ${accountId} AND u.user_id = ${userId}
      FOR SHARE OF p`);

    const accConsumed = Number(accUsage.rows[0].consumed);
    const usrConsumed = Number(usrUsage.rows[0].consumed);
    const accountState: LimitState = {
      monthlyAllowance: Number(accPlan.rows[0].monthly_allowance),
      maxPerRequest: accPlan.rows[0].max_per_request,
      consumed: accConsumed,
    };
    const userState: LimitState = {
      monthlyAllowance: Number(usrPlan.rows[0].monthly_allowance),
      maxPerRequest: usrPlan.rows[0].max_per_request,
      consumed: usrConsumed,
    };

    // 6) Decide (pure function, unit-tested separately).
    const decision = evaluateConsumption(units, accountState, userState);

    // 7) Accepted: add the units to BOTH counters. Rejected: counters untouched.
    if (decision.accepted) {
      await tx.execute(sql`
        UPDATE account_usage SET consumed = consumed + ${units}::bigint
        WHERE account_id = ${accountId} AND period_start = ${period}`);
      await tx.execute(sql`
        UPDATE user_usage SET consumed = consumed + ${units}::bigint
        WHERE account_id = ${accountId} AND user_id = ${userId} AND period_start = ${period}`);
    }

    // 8) Record the outcome, with a snapshot of the limits used, so replays and history stay stable.
    const added = decision.accepted ? units : 0;
    const snapshot: Snapshot = {
      account: view(accPlan.rows[0], accConsumed + added),
      user: view(usrPlan.rows[0], usrConsumed + added),
    };
    const reason = decision.accepted ? null : decision.reason;
    const scope = decision.accepted ? null : decision.scope;
    await tx.execute(sql`
      UPDATE usage_requests
      SET accepted = ${decision.accepted}, reason = ${reason}, scope = ${scope},
          applied_limits = ${JSON.stringify(snapshot)}::jsonb
      WHERE id = ${reservedId}`);

    return {
      requestId,
      userId,
      units,
      accepted: decision.accepted,
      reason,
      scope,
      period: period.slice(0, 7),
      replayed: false,
      ...snapshot,
    };
  });
}

/** A retry: return the stored decision unchanged (even if plans or the month changed since). */
async function replay(tx: Tx, input: ConsumeInput): Promise<ConsumeResult> {
  const res = await tx.execute<StoredRequest>(sql`
    SELECT user_id, units, accepted, reason, scope,
           to_char(period_start, 'YYYY-MM') AS period, applied_limits
    FROM usage_requests
    WHERE account_id = ${input.accountId} AND request_id = ${input.requestId}`);
  const row = res.rows[0];
  if (!row) throw new Error("Reserved request row disappeared"); // cannot happen: unique index + commit order

  if (row.user_id !== input.userId || row.units !== input.units) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This requestId was already used with a different userId or units.",
    );
  }
  return {
    requestId: input.requestId,
    userId: row.user_id,
    units: row.units,
    accepted: row.accepted,
    reason: row.reason,
    scope: row.scope,
    period: row.period,
    replayed: true,
    account: row.applied_limits.account,
    user: row.applied_limits.user,
  };
}
