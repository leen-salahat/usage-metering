import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp } from "../helpers/app.js";
import { consume, createUser, rid, setupScenario } from "../helpers/fixtures.js";

// Scenario (see setupScenario): account 100/month, 50 per request;
// alice and bob share a user plan of 60/month, 20 per request.
describe("usage reporting", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  beforeEach(() => t.clock.reset());
  afterAll(async () => {
    await t.close();
  });

  const spend = async (apiKey: string, userId: string, units: number) => {
    const r = await consume(t.api, apiKey, { userId, units, requestId: rid() });
    expect(r.body.accepted, `${userId} ${units}`).toBe(true);
  };

  it("reports a fresh account and user at zero usage, with their plans and limits", async () => {
    const s = await setupScenario(t.api);

    const acc = await t.api("GET", "/v1/usage", { apiKey: s.apiKey });
    expect(acc.status).toBe(200);
    expect(acc.body).toMatchObject({
      period: "2026-10",
      planName: "Acct-100",
      monthlyAllowance: 100,
      maxPerRequest: 50,
      consumed: 0,
      remaining: 100,
    });

    const usr = await t.api("GET", "/v1/users/alice/usage", { apiKey: s.apiKey });
    expect(usr.status).toBe(200);
    expect(usr.body.userId).toBe("alice");
    expect(usr.body.user).toMatchObject({
      planName: "Std-60",
      monthlyAllowance: 60,
      maxPerRequest: 20,
      consumed: 0,
      remaining: 60,
    });
    expect(usr.body.account).toMatchObject({ consumed: 0, remaining: 100 });
  });

  it("account usage is the sum of its users; each user sees its own usage plus the shared account numbers", async () => {
    const s = await setupScenario(t.api);
    await spend(s.apiKey, "alice", 20);
    await spend(s.apiKey, "alice", 10);
    await spend(s.apiKey, "bob", 15);

    const acc = await t.api("GET", "/v1/usage", { apiKey: s.apiKey });
    expect(acc.body).toMatchObject({ consumed: 45, remaining: 55 });

    const alice = await t.api("GET", "/v1/users/alice/usage", { apiKey: s.apiKey });
    expect(alice.body.user).toMatchObject({ consumed: 30, remaining: 30 });
    expect(alice.body.account).toMatchObject({ consumed: 45, remaining: 55 });

    const bob = await t.api("GET", "/v1/users/bob/usage", { apiKey: s.apiKey });
    expect(bob.body.user).toMatchObject({ consumed: 15, remaining: 45 });
    expect(bob.body.account).toMatchObject({ consumed: 45, remaining: 55 });
  });

  it("maxConsumableNow is the tightest of the four limits", async () => {
    const s = await setupScenario(t.api);
    const fresh = await t.api("GET", "/v1/users/alice/usage", { apiKey: s.apiKey });
    expect(fresh.body.maxConsumableNow).toBe(20); // user max per request

    for (const u of [20, 20, 10]) await spend(s.apiKey, "alice", u); // alice 50/60
    for (const u of [20, 20, 5]) await spend(s.apiKey, "bob", u); // bob 45/60, account 95/100

    const bob = await t.api("GET", "/v1/users/bob/usage", { apiKey: s.apiKey });
    expect(bob.body.user.remaining).toBe(15);
    expect(bob.body.account.remaining).toBe(5);
    expect(bob.body.maxConsumableNow).toBe(5); // limited by the shared account

    const alice = await t.api("GET", "/v1/users/alice/usage", { apiKey: s.apiKey });
    expect(alice.body.user.remaining).toBe(10);
    expect(alice.body.maxConsumableNow).toBe(5); // account (5) is tighter than alice (10)
  });

  it("reports zero remaining (never negative) when the allowance is lowered below usage, and reacts to a raise immediately", async () => {
    const s = await setupScenario(t.api);
    await spend(s.apiKey, "alice", 20);
    await spend(s.apiKey, "alice", 20); // alice consumed 40

    await t.api("PATCH", `/v1/plans/${s.userPlanId}`, { apiKey: s.apiKey, body: { monthlyAllowance: 30 } });
    const low = await t.api("GET", "/v1/users/alice/usage", { apiKey: s.apiKey });
    expect(low.body.user).toMatchObject({ monthlyAllowance: 30, consumed: 40, remaining: 0 });
    expect(low.body.maxConsumableNow).toBe(0);

    // bob shares the PLAN, not alice's usage
    const bob = await t.api("GET", "/v1/users/bob/usage", { apiKey: s.apiKey });
    expect(bob.body.user).toMatchObject({ consumed: 0, remaining: 30 });

    await t.api("PATCH", `/v1/plans/${s.userPlanId}`, { apiKey: s.apiKey, body: { monthlyAllowance: 100 } });
    const high = await t.api("GET", "/v1/users/alice/usage", { apiKey: s.apiKey });
    expect(high.body.user).toMatchObject({ consumed: 40, remaining: 60 }); // usage was kept
    expect(high.body.maxConsumableNow).toBe(20);
  });

  it("a new UTC month starts at zero while previous months stay available (account and user)", async () => {
    const s = await setupScenario(t.api);
    t.clock.set("2026-10-31T23:59:59.000Z");
    await spend(s.apiKey, "alice", 20);
    t.clock.set("2026-11-01T00:00:00.000Z");
    await spend(s.apiKey, "alice", 10);

    const acc = await t.api("GET", "/v1/usage", { apiKey: s.apiKey });
    expect(acc.body).toMatchObject({ period: "2026-11", consumed: 10, remaining: 90 });
    const usr = await t.api("GET", "/v1/users/alice/usage", { apiKey: s.apiKey });
    expect(usr.body).toMatchObject({ period: "2026-11" });
    expect(usr.body.user.consumed).toBe(10);

    const months = [
      { period: "2026-11", consumed: 10 },
      { period: "2026-10", consumed: 20 },
    ];
    const accHist = await t.api("GET", "/v1/usage/history", { apiKey: s.apiKey });
    expect(accHist.body.months).toEqual(months);
    const usrHist = await t.api("GET", "/v1/users/alice/usage/history", { apiKey: s.apiKey });
    expect(usrHist.body).toEqual({ userId: "alice", months });

    const limited = await t.api("GET", "/v1/usage/history?limit=1", { apiKey: s.apiKey });
    expect(limited.body.months).toEqual([months[0]]);

    const bobHist = await t.api("GET", "/v1/users/bob/usage/history", { apiKey: s.apiKey });
    expect(bobHist.body.months).toEqual([]); // bob never consumed
  });

  it("hides unknown and foreign users (404) on both user usage endpoints", async () => {
    const a = await setupScenario(t.api, "A");
    const b = await setupScenario(t.api, "B");
    await createUser(t.api, a.apiKey, "only-in-a", a.userPlanId);

    for (const path of [
      "/v1/users/only-in-a/usage",
      "/v1/users/only-in-a/usage/history",
      "/v1/users/nobody/usage",
      "/v1/users/nobody/usage/history",
    ]) {
      const res = await t.api("GET", path, { apiKey: b.apiKey });
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe("USER_NOT_FOUND");
    }
  });

  it("requires an API key and validates the limit parameter", async () => {
    for (const path of [
      "/v1/usage",
      "/v1/usage/history",
      "/v1/users/alice/usage",
      "/v1/users/alice/usage/history",
    ]) {
      const res = await t.api("GET", path);
      expect(res.status, path).toBe(401);
    }
    const s = await setupScenario(t.api);
    for (const q of ["limit=0", "limit=25", "limit=abc"]) {
      const res = await t.api("GET", `/v1/usage/history?${q}`, { apiKey: s.apiKey });
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
