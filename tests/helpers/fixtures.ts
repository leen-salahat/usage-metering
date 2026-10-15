import type pg from "pg";
import { expect } from "vitest";
import { createAccountViaApi, type Api } from "./app.js";

let counter = 0;
/** A unique request id for tests that do not care about its value. */
export const rid = () => `req-${++counter}`;

export async function createPlan(
  api: Api,
  apiKey: string,
  body: { kind: "account" | "user"; name: string; monthlyAllowance: number; maxPerRequest: number },
) {
  const res = await api("POST", "/v1/plans", { apiKey, body });
  if (res.status !== 201) throw new Error(`createPlan failed: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export async function createUser(api: Api, apiKey: string, userId: string, planId?: string) {
  const res = await api("POST", "/v1/users", {
    apiKey,
    body: planId ? { userId, planId } : { userId },
  });
  if (res.status !== 201) throw new Error(`createUser failed: ${JSON.stringify(res.body)}`);
}

export function consume(
  api: Api,
  apiKey: string,
  body: { userId: string; units: number; requestId: string },
) {
  return api("POST", "/v1/consume", { apiKey, body });
}

/**
 * Account plan: 100 units/month, max 50 per request.
 * Users "alice" and "bob" SHARE one user plan: 60 units/month, max 20 per request.
 */
export async function setupScenario(api: Api, name = "Scenario") {
  const { id, apiKey } = await createAccountViaApi(api, name);
  const accountPlanId = await createPlan(api, apiKey, {
    kind: "account",
    name: "Acct-100",
    monthlyAllowance: 100,
    maxPerRequest: 50,
  });
  const put = await api("PUT", "/v1/account/plan", { apiKey, body: { planId: accountPlanId } });
  expect(put.status).toBe(200);
  const userPlanId = await createPlan(api, apiKey, {
    kind: "user",
    name: "Std-60",
    monthlyAllowance: 60,
    maxPerRequest: 20,
  });
  await createUser(api, apiKey, "alice", userPlanId);
  await createUser(api, apiKey, "bob", userPlanId);
  return { id, apiKey, accountPlanId, userPlanId };
}

/**
 * The core accounting invariants, per UTC month:
 *   account consumed == sum of its users' consumed == sum of ACCEPTED request units.
 */
export async function expectInvariants(pool: pg.Pool, accountId: string) {
  const { rows } = await pool.query(
    `SELECT a.period_start::text AS period,
            a.consumed::int AS account_consumed,
            COALESCE((SELECT SUM(u.consumed) FROM user_usage u
                      WHERE u.account_id = a.account_id AND u.period_start = a.period_start), 0)::int AS users_sum,
            COALESCE((SELECT SUM(r.units) FROM usage_requests r
                      WHERE r.account_id = a.account_id AND r.period_start = a.period_start AND r.accepted), 0)::int AS accepted_sum
     FROM account_usage a WHERE a.account_id = $1 ORDER BY a.period_start`,
    [accountId],
  );
  for (const r of rows) {
    expect(r.users_sum, `users sum vs account in ${r.period}`).toBe(r.account_consumed);
    expect(r.accepted_sum, `accepted requests vs account in ${r.period}`).toBe(r.account_consumed);
  }
  return rows as { period: string; account_consumed: number; users_sum: number; accepted_sum: number }[];
}
