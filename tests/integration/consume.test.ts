import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountViaApi, setupTestApp } from "../helpers/app.js";
import { consume, createUser, expectInvariants, rid, setupScenario } from "../helpers/fixtures.js";

describe("consume: rules, boundaries, validation, isolation, months", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  beforeEach(() => t.clock.reset());
  afterAll(async () => {
    await t.close();
  });

  it("accepts a valid request and adds the units to BOTH the user and the account", async () => {
    const s = await setupScenario(t.api);
    const res = await consume(t.api, s.apiKey, { userId: "alice", units: 10, requestId: "r-ok" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      requestId: "r-ok",
      userId: "alice",
      units: 10,
      accepted: true,
      reason: null,
      scope: null,
      period: "2026-10",
      replayed: false,
    });
    expect(res.body.user).toMatchObject({ consumed: 10, remaining: 50, monthlyAllowance: 60, maxPerRequest: 20 });
    expect(res.body.account).toMatchObject({ consumed: 10, remaining: 90, monthlyAllowance: 100, maxPerRequest: 50 });

    const { rows } = await t.pool.query(
      "SELECT accepted, units FROM usage_requests WHERE account_id = $1 AND request_id = 'r-ok'",
      [s.id],
    );
    expect(rows).toEqual([{ accepted: true, units: 10 }]);
    await expectInvariants(t.pool, s.id);
  });

  it("rejects on the user's per-request limit and consumes nothing (HTTP 200, accepted:false)", async () => {
    const s = await setupScenario(t.api);
    const res = await consume(t.api, s.apiKey, { userId: "alice", units: 25, requestId: "r-big" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accepted: false,
      reason: "PER_REQUEST_LIMIT_EXCEEDED",
      scope: "user",
    });
    expect(res.body.user.consumed).toBe(0);
    expect(res.body.account.consumed).toBe(0);

    const { rows } = await t.pool.query(
      "SELECT accepted, reason, scope FROM usage_requests WHERE account_id = $1 AND request_id = 'r-big'",
      [s.id],
    );
    expect(rows).toEqual([{ accepted: false, reason: "PER_REQUEST_LIMIT_EXCEEDED", scope: "user" }]);
    const sums = await expectInvariants(t.pool, s.id);
    expect(sums.every((r) => r.account_consumed === 0)).toBe(true);
  });

  it("per-request boundary: exactly the limit is accepted, one more is rejected", async () => {
    const s = await setupScenario(t.api);
    const atLimit = await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() });
    const over = await consume(t.api, s.apiKey, { userId: "alice", units: 21, requestId: rid() });
    expect(atLimit.body.accepted).toBe(true);
    expect(over.body).toMatchObject({ accepted: false, reason: "PER_REQUEST_LIMIT_EXCEEDED", scope: "user" });
  });

  it("rejects on the SHARED account allowance although the user has capacity (5 left, 10 requested)", async () => {
    const s = await setupScenario(t.api);
    for (let i = 0; i < 3; i++) {
      const r = await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() });
      expect(r.body.accepted).toBe(true); // alice: 60/60, account: 60/100
    }
    expect((await consume(t.api, s.apiKey, { userId: "bob", units: 20, requestId: rid() })).body.accepted).toBe(true);
    expect((await consume(t.api, s.apiKey, { userId: "bob", units: 15, requestId: rid() })).body.accepted).toBe(true);
    // account consumed 95 -> 5 left; bob consumed 35 -> 25 left

    const rejected = await consume(t.api, s.apiKey, { userId: "bob", units: 10, requestId: rid() });
    expect(rejected.body).toMatchObject({
      accepted: false,
      reason: "MONTHLY_ALLOWANCE_EXCEEDED",
      scope: "account",
    });
    expect(rejected.body.account).toMatchObject({ consumed: 95, remaining: 5 });
    expect(rejected.body.user).toMatchObject({ consumed: 35, remaining: 25 });

    const exact = await consume(t.api, s.apiKey, { userId: "bob", units: 5, requestId: rid() });
    expect(exact.body.accepted).toBe(true);
    expect(exact.body.account.remaining).toBe(0);

    const overByOne = await consume(t.api, s.apiKey, { userId: "bob", units: 1, requestId: rid() });
    expect(overByOne.body).toMatchObject({ accepted: false, scope: "account" });
    await expectInvariants(t.pool, s.id);
  });

  it("rejects on the user's monthly allowance while other users and the account keep capacity", async () => {
    const s = await setupScenario(t.api);
    for (let i = 0; i < 3; i++) {
      await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() });
    }
    const rejected = await consume(t.api, s.apiKey, { userId: "alice", units: 1, requestId: rid() });
    expect(rejected.body).toMatchObject({ accepted: false, reason: "MONTHLY_ALLOWANCE_EXCEEDED", scope: "user" });
    expect(rejected.body.account).toMatchObject({ consumed: 60, remaining: 40 });

    // bob shares alice's PLAN but has his own, untouched usage
    const bob = await consume(t.api, s.apiKey, { userId: "bob", units: 20, requestId: rid() });
    expect(bob.body.accepted).toBe(true);
    expect(bob.body.user.consumed).toBe(20);
  });

  it("rejects malformed payloads with 400 and records nothing", async () => {
    const s = await setupScenario(t.api);
    const base = { userId: "alice", units: 5, requestId: "x" };
    const bad: unknown[] = [
      { ...base, units: 0 },
      { ...base, units: -3 },
      { ...base, units: 1.5 },
      { ...base, units: "5" },
      { ...base, units: null },
      { ...base, units: 2_147_483_648 },
      { userId: "alice", requestId: "x" },
      { units: 5, requestId: "x" },
      { userId: "alice", units: 5 },
      { ...base, requestId: "" },
      { ...base, requestId: "r".repeat(129) },
      { ...base, requestId: 42 },
      { ...base, requestId: "has space" },
    ];
    for (const body of bad) {
      const res = await t.api("POST", "/v1/consume", { apiKey: s.apiKey, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM usage_requests WHERE account_id = $1", [s.id]);
    expect(rows[0].n).toBe(0);
  });

  it("requires a valid API key", async () => {
    const body = { userId: "alice", units: 5, requestId: "r1" };
    const missing = await t.api("POST", "/v1/consume", { body });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("MISSING_API_KEY");
    const wrong = await t.api("POST", "/v1/consume", { apiKey: "mk_wrong", body });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_API_KEY");
  });

  it("isolates accounts: unknown or foreign users are 404, a body accountId is ignored, same userIds stay independent", async () => {
    const a = await setupScenario(t.api, "A");
    const b = await setupScenario(t.api, "B");
    await createUser(t.api, a.apiKey, "only-in-a", a.userPlanId);

    const unknown = await consume(t.api, b.apiKey, { userId: "nobody", units: 1, requestId: rid() });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("USER_NOT_FOUND");

    // B tries to spend A's user, even pretending to be A through the body
    const foreign = await t.api("POST", "/v1/consume", {
      apiKey: b.apiKey,
      body: { userId: "only-in-a", units: 1, requestId: rid(), accountId: a.id },
    });
    expect(foreign.status).toBe(404);

    // "alice" exists in both accounts: usage is completely independent
    await consume(t.api, a.apiKey, { userId: "alice", units: 10, requestId: rid() });
    const bAlice = await consume(t.api, b.apiKey, { userId: "alice", units: 5, requestId: rid() });
    expect(bAlice.body.user.consumed).toBe(5);
    expect(bAlice.body.account.consumed).toBe(5);

    const rows = await t.pool.query(
      "SELECT account_id, consumed::int AS c FROM account_usage WHERE account_id IN ($1, $2) ORDER BY c",
      [a.id, b.id],
    );
    expect(rows.rows.map((r) => r.c)).toEqual([5, 10]);
    const reqs = await t.pool.query("SELECT count(*)::int AS n FROM usage_requests WHERE account_id = $1", [a.id]);
    expect(reqs.rows[0].n).toBe(1); // only A's own legitimate request
  });

  it("plan changes apply to the next request and preserve consumed units (lower, then raise)", async () => {
    const s = await setupScenario(t.api);
    await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() });
    await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() }); // alice consumed 40

    // lower the shared plan below existing usage
    const lower = await t.api("PATCH", `/v1/plans/${s.userPlanId}`, {
      apiKey: s.apiKey,
      body: { monthlyAllowance: 30 },
    });
    expect(lower.status).toBe(200);
    const blocked = await consume(t.api, s.apiKey, { userId: "alice", units: 1, requestId: rid() });
    expect(blocked.body).toMatchObject({ accepted: false, reason: "MONTHLY_ALLOWANCE_EXCEEDED", scope: "user" });
    expect(blocked.body.user).toMatchObject({ monthlyAllowance: 30, consumed: 40, remaining: 0 });

    // raise it: usage was NOT reset, it continues from 40
    await t.api("PATCH", `/v1/plans/${s.userPlanId}`, { apiKey: s.apiKey, body: { monthlyAllowance: 100 } });
    const ok = await consume(t.api, s.apiKey, { userId: "alice", units: 1, requestId: rid() });
    expect(ok.body.accepted).toBe(true);
    expect(ok.body.user).toMatchObject({ consumed: 41, remaining: 59 });
    await expectInvariants(t.pool, s.id);
  });

  it("does not rewrite past decisions when a plan changes (snapshot keeps the old limits)", async () => {
    const s = await setupScenario(t.api);
    await consume(t.api, s.apiKey, { userId: "alice", units: 10, requestId: "old-decision" });
    await t.api("PATCH", `/v1/plans/${s.userPlanId}`, { apiKey: s.apiKey, body: { monthlyAllowance: 30 } });

    const { rows } = await t.pool.query(
      "SELECT accepted, applied_limits FROM usage_requests WHERE account_id = $1 AND request_id = 'old-decision'",
      [s.id],
    );
    expect(rows[0].accepted).toBe(true);
    expect(rows[0].applied_limits.user.monthlyAllowance).toBe(60); // limits at decision time
    expect(rows[0].applied_limits.account.monthlyAllowance).toBe(100);
  });

  it("uses UTC calendar months: a new month starts at zero and October stays queryable", async () => {
    const s = await setupScenario(t.api);

    t.clock.set("2026-10-31T23:59:59.000Z");
    for (let i = 0; i < 3; i++) {
      const r = await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() });
      expect(r.body.period).toBe("2026-10");
    }
    const exhausted = await consume(t.api, s.apiKey, { userId: "alice", units: 1, requestId: rid() });
    expect(exhausted.body.accepted).toBe(false); // alice used 60/60 in October

    t.clock.set("2026-11-01T00:00:00.000Z");
    const november = await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() });
    expect(november.body).toMatchObject({ accepted: true, period: "2026-11" });
    expect(november.body.user.consumed).toBe(20); // fresh month, not 80
    expect(november.body.account.consumed).toBe(20);

    const rows = await expectInvariants(t.pool, s.id);
    expect(rows.map((r) => [r.period, r.account_consumed])).toEqual([
      ["2026-10-01", 60],
      ["2026-11-01", 20],
    ]);
  });

  it("accepts the default predefined plans too (Starter account, Basic user)", async () => {
    const { id, apiKey } = await createAccountViaApi(t.api, "Defaults");
    await createUser(t.api, apiKey, "u1"); // Basic: 500/month, 20 per request
    const ok = await consume(t.api, apiKey, { userId: "u1", units: 20, requestId: rid() });
    expect(ok.body).toMatchObject({ accepted: true });
    expect(ok.body.user.planName).toBe("Basic");
    expect(ok.body.account.planName).toBe("Starter");
    const over = await consume(t.api, apiKey, { userId: "u1", units: 21, requestId: rid() });
    expect(over.body).toMatchObject({ accepted: false, scope: "user" });
    await expectInvariants(t.pool, id);
  });
});
