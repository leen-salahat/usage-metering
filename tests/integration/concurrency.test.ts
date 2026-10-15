import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import { createAccountViaApi, setupTestApp } from "../helpers/app.js";
import { consume, createPlan, createUser, expectInvariants, setupScenario } from "../helpers/fixtures.js";

describe("concurrency and atomic accounting", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("two concurrent 7-unit requests on an account with 10 left: exactly one is accepted (15 rounds)", async () => {
    for (let round = 0; round < 15; round++) {
      const { id, apiKey } = await createAccountViaApi(t.api, `Race-${round}`);
      const planId = await createPlan(t.api, apiKey, {
        kind: "account",
        name: "Ten",
        monthlyAllowance: 10,
        maxPerRequest: 100,
      });
      await t.api("PUT", "/v1/account/plan", { apiKey, body: { planId } });
      await createUser(t.api, apiKey, "u1"); // Basic: max 20 per request
      await createUser(t.api, apiKey, "u2");

      const [r1, r2] = await Promise.all([
        consume(t.api, apiKey, { userId: "u1", units: 7, requestId: "c-1" }),
        consume(t.api, apiKey, { userId: "u2", units: 7, requestId: "c-2" }),
      ]);
      const accepted = [r1, r2].filter((r) => r.body.accepted);
      const rejected = [r1, r2].filter((r) => !r.body.accepted);
      expect(accepted, `round ${round}`).toHaveLength(1);
      expect(rejected[0].body).toMatchObject({ reason: "MONTHLY_ALLOWANCE_EXCEEDED", scope: "account" });

      const rows = await expectInvariants(t.pool, id);
      expect(rows[0].account_consumed).toBe(7);
    }
  });

  it("two concurrent requests from the SAME user competing for the user's allowance: exactly one wins", async () => {
    const { id, apiKey } = await createAccountViaApi(t.api, "SameUser");
    const planId = await createPlan(t.api, apiKey, {
      kind: "user",
      name: "Ten",
      monthlyAllowance: 10,
      maxPerRequest: 20,
    });
    await createUser(t.api, apiKey, "u1", planId);

    const results = await Promise.all([
      consume(t.api, apiKey, { userId: "u1", units: 7, requestId: "s-1" }),
      consume(t.api, apiKey, { userId: "u1", units: 7, requestId: "s-2" }),
    ]);
    expect(results.filter((r) => r.body.accepted)).toHaveLength(1);
    expect(results.find((r) => !r.body.accepted)?.body).toMatchObject({ scope: "user" });
    await expectInvariants(t.pool, id);
  });

  it("50 concurrent 1-unit requests across 5 users against an allowance of 20: exactly 20 accepted", async () => {
    const { id, apiKey } = await createAccountViaApi(t.api, "Burst");
    const planId = await createPlan(t.api, apiKey, {
      kind: "account",
      name: "Twenty",
      monthlyAllowance: 20,
      maxPerRequest: 10,
    });
    await t.api("PUT", "/v1/account/plan", { apiKey, body: { planId } });
    for (let i = 0; i < 5; i++) await createUser(t.api, apiKey, `u${i}`, PLAN_IDS.premium);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        consume(t.api, apiKey, { userId: `u${i % 5}`, units: 1, requestId: `burst-${i}` }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true); // no 500s, no deadlocks
    expect(results.filter((r) => r.body.accepted)).toHaveLength(20);
    const rejected = results.filter((r) => !r.body.accepted);
    expect(rejected).toHaveLength(30);
    expect(rejected.every((r) => r.body.scope === "account")).toBe(true);

    const rows = await expectInvariants(t.pool, id);
    expect(rows[0].account_consumed).toBe(20);
  });

  it("is all-or-nothing: a failure while updating the user counter rolls back the account counter and the request record", async () => {
    const s = await setupScenario(t.api);
    await createUser(t.api, s.apiKey, "boom", s.userPlanId);

    // Test-only trigger: any UPDATE of user "boom"'s usage raises an error AFTER the account counter was updated.
    await t.pool.query(`
      CREATE OR REPLACE FUNCTION simulate_failure() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER simulate_failure_trg BEFORE UPDATE ON user_usage
      FOR EACH ROW WHEN (NEW.user_id = 'boom') EXECUTE FUNCTION simulate_failure();
    `);
    try {
      const res = await consume(t.api, s.apiKey, { userId: "boom", units: 10, requestId: "atomic-1" });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");

      const usage = await t.pool.query(
        "SELECT COALESCE(SUM(consumed), 0)::int AS n FROM account_usage WHERE account_id = $1",
        [s.id],
      );
      expect(usage.rows[0].n).toBe(0); // account counter was rolled back
      const reqs = await t.pool.query(
        "SELECT count(*)::int AS n FROM usage_requests WHERE account_id = $1 AND request_id = 'atomic-1'",
        [s.id],
      );
      expect(reqs.rows[0].n).toBe(0); // the reservation was rolled back too
    } finally {
      await t.pool.query("DROP TRIGGER simulate_failure_trg ON user_usage");
    }

    // Because the reservation was rolled back, the same request id can now succeed normally.
    const retry = await consume(t.api, s.apiKey, { userId: "boom", units: 10, requestId: "atomic-1" });
    expect(retry.body).toMatchObject({ accepted: true, replayed: false });
    const rows = await expectInvariants(t.pool, s.id);
    expect(rows[0].account_consumed).toBe(10);
  });
});
