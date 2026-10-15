import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp } from "../helpers/app.js";
import { consume, expectInvariants, rid, setupScenario } from "../helpers/fixtures.js";

describe("idempotency", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  beforeEach(() => t.clock.reset());
  afterAll(async () => {
    await t.close();
  });

  const countRows = async (accountId: string, requestId: string) =>
    (
      await t.pool.query(
        "SELECT count(*)::int AS n FROM usage_requests WHERE account_id = $1 AND request_id = $2",
        [accountId, requestId],
      )
    ).rows[0].n as number;

  it("a retry of an ACCEPTED request returns the same decision and consumes only once", async () => {
    const s = await setupScenario(t.api);
    const body = { userId: "alice", units: 10, requestId: "pay-1" };
    const first = await consume(t.api, s.apiKey, body);
    const again = await consume(t.api, s.apiKey, body);

    expect(first.body.replayed).toBe(false);
    expect(again.body.replayed).toBe(true);
    expect({ ...again.body, replayed: false }).toEqual(first.body);
    expect(again.body.user.consumed).toBe(10);
    expect(await countRows(s.id, "pay-1")).toBe(1);
    const rows = await expectInvariants(t.pool, s.id);
    expect(rows[0].account_consumed).toBe(10);
  });

  it("a retry of a REJECTED request stays rejected even after the plan would now allow it", async () => {
    const s = await setupScenario(t.api);
    const body = { userId: "alice", units: 25, requestId: "big-1" };
    const first = await consume(t.api, s.apiKey, body);
    expect(first.body).toMatchObject({ accepted: false, scope: "user", reason: "PER_REQUEST_LIMIT_EXCEEDED" });

    await t.api("PATCH", `/v1/plans/${s.userPlanId}`, { apiKey: s.apiKey, body: { maxPerRequest: 100 } });

    const retry = await consume(t.api, s.apiKey, body);
    expect(retry.body).toMatchObject({ accepted: false, replayed: true, scope: "user" }); // original decision is stable

    const fresh = await consume(t.api, s.apiKey, { ...body, requestId: "big-2" }); // a NEW id is evaluated again
    expect(fresh.body.accepted).toBe(true);
    await expectInvariants(t.pool, s.id);
  });

  it("a retry of an ACCEPTED request stays accepted even after the allowance was lowered", async () => {
    const s = await setupScenario(t.api);
    const body = { userId: "alice", units: 10, requestId: "keep-1" };
    await consume(t.api, s.apiKey, body);
    await t.api("PATCH", `/v1/plans/${s.userPlanId}`, { apiKey: s.apiKey, body: { monthlyAllowance: 0 } });

    const retry = await consume(t.api, s.apiKey, body);
    expect(retry.body).toMatchObject({ accepted: true, replayed: true });
    expect(retry.body.user.consumed).toBe(10);

    const next = await consume(t.api, s.apiKey, { ...body, requestId: "keep-2", units: 1 });
    expect(next.body.accepted).toBe(false); // new requests DO see the new plan
  });

  it("reusing a requestId with a different units or userId returns 409 and changes nothing", async () => {
    const s = await setupScenario(t.api);
    await consume(t.api, s.apiKey, { userId: "alice", units: 10, requestId: "pay-4" });

    const otherUnits = await consume(t.api, s.apiKey, { userId: "alice", units: 11, requestId: "pay-4" });
    expect(otherUnits.status).toBe(409);
    expect(otherUnits.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const otherUser = await consume(t.api, s.apiKey, { userId: "bob", units: 10, requestId: "pay-4" });
    expect(otherUser.status).toBe(409);

    expect(await countRows(s.id, "pay-4")).toBe(1);
    const rows = await expectInvariants(t.pool, s.id);
    expect(rows[0].account_consumed).toBe(10);
  });

  it("request ids are scoped per account: two accounts may use the same id independently", async () => {
    const a = await setupScenario(t.api, "A");
    const b = await setupScenario(t.api, "B");
    const body = { userId: "alice", units: 10, requestId: "shared-id" };
    const ra = await consume(t.api, a.apiKey, body);
    const rb = await consume(t.api, b.apiKey, body);
    expect(ra.body).toMatchObject({ accepted: true, replayed: false });
    expect(rb.body).toMatchObject({ accepted: true, replayed: false });
  });

  it("10 identical concurrent retries consume exactly once", async () => {
    const s = await setupScenario(t.api);
    const body = { userId: "alice", units: 10, requestId: "race-1" };
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(t.api, s.apiKey, body)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1); // exactly one real execution
    expect(results.every((r) => r.body.accepted === true)).toBe(true);
    expect(results.every((r) => r.body.user.consumed === 10)).toBe(true);
    expect(await countRows(s.id, "race-1")).toBe(1);
    const rows = await expectInvariants(t.pool, s.id);
    expect(rows[0].account_consumed).toBe(10);
  });

  it("a retry in a later month returns the original decision and period, and touches no usage", async () => {
    const s = await setupScenario(t.api);
    const body = { userId: "alice", units: 10, requestId: rid() };
    await consume(t.api, s.apiKey, body);

    t.clock.set("2026-11-02T08:00:00.000Z");
    const retry = await consume(t.api, s.apiKey, body);
    expect(retry.body).toMatchObject({ replayed: true, period: "2026-10", accepted: true });

    const nov = await t.pool.query(
      "SELECT count(*)::int AS n FROM account_usage WHERE account_id = $1 AND period_start = '2026-11-01'",
      [s.id],
    );
    expect(nov.rows[0].n).toBe(0);
  });
});
