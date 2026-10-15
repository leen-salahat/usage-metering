import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { utcPeriodStart } from "../domain/period.js";
import { remaining } from "../domain/quota.js";
import { AppError } from "../errors.js";

/** Same shape as the per-level view returned by POST /v1/consume. */
export interface LevelUsage {
  planId: string;
  planName: string;
  monthlyAllowance: number;
  maxPerRequest: number;
  consumed: number;
  remaining: number;
}

function level(
  planId: string,
  planName: string,
  allowance: string, // pg returns bigint as string
  maxPerRequest: number,
  consumed: string,
): LevelUsage {
  const monthlyAllowance = Number(allowance);
  const used = Number(consumed);
  return {
    planId,
    planName,
    monthlyAllowance,
    maxPerRequest,
    consumed: used,
    remaining: remaining(monthlyAllowance, used), // never negative
  };
}

type AccountRow = {
  plan_id: string;
  plan_name: string;
  monthly_allowance: string;
  max_per_request: number;
  consumed: string;
};

/** Current UTC month usage of the account, with the plan that applies right now. */
export async function getAccountUsage(db: Db, accountId: string, now: Date) {
  const period = utcPeriodStart(now);
  const res = await db.execute<AccountRow>(sql`
    SELECT p.id AS plan_id, p.name AS plan_name, p.monthly_allowance, p.max_per_request,
           COALESCE(u.consumed, 0) AS consumed
    FROM accounts a
    JOIN plans p ON p.id = a.plan_id
    LEFT JOIN account_usage u ON u.account_id = a.id AND u.period_start = ${period}
    WHERE a.id = ${accountId}`);
  const r = res.rows[0];
  if (!r) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
  return {
    period: period.slice(0, 7),
    ...level(r.plan_id, r.plan_name, r.monthly_allowance, r.max_per_request, r.consumed),
  };
}

type UserRow = {
  u_plan_id: string;
  u_plan_name: string;
  u_allowance: string;
  u_max: number;
  u_consumed: string;
  a_plan_id: string;
  a_plan_name: string;
  a_allowance: string;
  a_max: number;
  a_consumed: string;
};

/**
 * Current UTC month usage of one user AND of its account, read by ONE statement
 * so both sets of numbers come from the same snapshot.
 */
export async function getUserUsage(db: Db, accountId: string, userId: string, now: Date) {
  const period = utcPeriodStart(now);
  const res = await db.execute<UserRow>(sql`
    SELECT up.id AS u_plan_id, up.name AS u_plan_name,
           up.monthly_allowance AS u_allowance, up.max_per_request AS u_max,
           COALESCE(uu.consumed, 0) AS u_consumed,
           ap.id AS a_plan_id, ap.name AS a_plan_name,
           ap.monthly_allowance AS a_allowance, ap.max_per_request AS a_max,
           COALESCE(au.consumed, 0) AS a_consumed
    FROM users u
    JOIN plans up ON up.id = u.plan_id
    JOIN accounts a ON a.id = u.account_id
    JOIN plans ap ON ap.id = a.plan_id
    LEFT JOIN user_usage uu
      ON uu.account_id = u.account_id AND uu.user_id = u.user_id AND uu.period_start = ${period}
    LEFT JOIN account_usage au
      ON au.account_id = u.account_id AND au.period_start = ${period}
    WHERE u.account_id = ${accountId} AND u.user_id = ${userId}`);
  const r = res.rows[0];
  if (!r) throw new AppError(404, "USER_NOT_FOUND", "User not found.");

  const user = level(r.u_plan_id, r.u_plan_name, r.u_allowance, r.u_max, r.u_consumed);
  const account = level(r.a_plan_id, r.a_plan_name, r.a_allowance, r.a_max, r.a_consumed);
  return {
    userId,
    period: period.slice(0, 7),
    user,
    account,
    // Informational: the biggest single request that would be accepted right now.
    maxConsumableNow: Math.min(
      user.remaining,
      account.remaining,
      user.maxPerRequest,
      account.maxPerRequest,
    ),
  };
}

type MonthRow = { period: string; consumed: string };

/** Months in which the account has usage rows, newest first. */
export async function getAccountMonths(db: Db, accountId: string, limit: number) {
  const res = await db.execute<MonthRow>(sql`
    SELECT to_char(period_start, 'YYYY-MM') AS period, consumed
    FROM account_usage
    WHERE account_id = ${accountId}
    ORDER BY period_start DESC
    LIMIT ${limit}`);
  return res.rows.map((r) => ({ period: r.period, consumed: Number(r.consumed) }));
}

export async function getUserMonths(db: Db, accountId: string, userId: string, limit: number) {
  const exists = await db.execute(
    sql`SELECT 1 FROM users WHERE account_id = ${accountId} AND user_id = ${userId}`,
  );
  if (exists.rows.length === 0) throw new AppError(404, "USER_NOT_FOUND", "User not found.");

  const res = await db.execute<MonthRow>(sql`
    SELECT to_char(period_start, 'YYYY-MM') AS period, consumed
    FROM user_usage
    WHERE account_id = ${accountId} AND user_id = ${userId}
    ORDER BY period_start DESC
    LIMIT ${limit}`);
  return res.rows.map((r) => ({ period: r.period, consumed: Number(r.consumed) }));
}
