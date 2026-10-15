import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findInvariantViolations } from "../../src/db/invariants.js";
import { setupTestApp } from "../helpers/app.js";
import { consume, rid, setupScenario } from "../helpers/fixtures.js";

describe("invariants checker", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("reports no violations after normal traffic (accepted and rejected requests)", async () => {
    const s = await setupScenario(t.api);
    await consume(t.api, s.apiKey, { userId: "alice", units: 20, requestId: rid() });
    await consume(t.api, s.apiKey, { userId: "bob", units: 15, requestId: rid() });
    await consume(t.api, s.apiKey, { userId: "bob", units: 25, requestId: rid() }); // rejected

    const res = await t.pool.query("SELECT 1"); // keep the pool warm
    expect(res.rowCount).toBe(1);
    const { checked, violations } = await findInvariantViolations(t.pool);
    expect(checked).toBeGreaterThanOrEqual(1);
    expect(violations).toEqual([]);
  });

  it("detects a corrupted counter (the checker really checks)", async () => {
    const s = await setupScenario(t.api);
    await consume(t.api, s.apiKey, { userId: "alice", units: 10, requestId: rid() });

    // Simulate a bug: the account counter drifts from its users and from the accepted requests.
    await t.pool.query("UPDATE account_usage SET consumed = consumed + 1 WHERE account_id = $1", [s.id]);

    const { violations } = await findInvariantViolations(t.pool);
    const mine = violations.filter((v) => v.accountId === s.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ accountConsumed: 11, usersSum: 10, acceptedSum: 10 });
  });
});
