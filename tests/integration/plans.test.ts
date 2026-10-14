import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import { createAccountViaApi, setupTestApp } from "../helpers/app.js";

describe("plans", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const teamPlan = { kind: "user", name: "Team", monthlyAllowance: 100, maxPerRequest: 10 };

  it("lists the 4 predefined plans for a new account, and filters by kind", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const all = await t.api("GET", "/v1/plans", { apiKey: a.apiKey });
    expect(all.status).toBe(200);
    expect(all.body.plans.map((p: { name: string }) => p.name)).toEqual([
      "Pro",
      "Starter",
      "Basic",
      "Premium",
    ]);
    const users = await t.api("GET", "/v1/plans?kind=user", { apiKey: a.apiKey });
    expect(users.body.plans.map((p: { name: string }) => p.name)).toEqual(["Basic", "Premium"]);

    const bad = await t.api("GET", "/v1/plans?kind=team", { apiKey: a.apiKey });
    expect(bad.status).toBe(400);
  });

  it("creates a custom plan that only its owner can see", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const b = await createAccountViaApi(t.api, "B");
    const created = await t.api("POST", "/v1/plans", { apiKey: a.apiKey, body: teamPlan });
    expect(created.status).toBe(201);
    expect(created.body.isPredefined).toBe(false);
    expect(created.body.monthlyAllowance).toBe(100);

    const listA = await t.api("GET", "/v1/plans", { apiKey: a.apiKey });
    const listB = await t.api("GET", "/v1/plans", { apiKey: b.apiKey });
    expect(listA.body.plans).toHaveLength(5);
    expect(listB.body.plans).toHaveLength(4);
  });

  it("enforces unique plan names per (account, kind) only", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const b = await createAccountViaApi(t.api, "B");
    const first = await t.api("POST", "/v1/plans", { apiKey: a.apiKey, body: teamPlan });
    expect(first.status).toBe(201);

    const dup = await t.api("POST", "/v1/plans", { apiKey: a.apiKey, body: teamPlan });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("PLAN_NAME_TAKEN");

    const otherKind = await t.api("POST", "/v1/plans", {
      apiKey: a.apiKey,
      body: { ...teamPlan, kind: "account" },
    });
    expect(otherKind.status).toBe(201);

    const otherAccount = await t.api("POST", "/v1/plans", { apiKey: b.apiKey, body: teamPlan });
    expect(otherAccount.status).toBe(201);
  });

  it("rejects invalid plan values (zero, negative, fractional, wrong type)", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const bodies = [
      { ...teamPlan, maxPerRequest: 0 },
      { ...teamPlan, maxPerRequest: -5 },
      { ...teamPlan, maxPerRequest: 1.5 },
      { ...teamPlan, monthlyAllowance: -1 },
      { ...teamPlan, monthlyAllowance: "100" },
      { ...teamPlan, name: "   " },
      { ...teamPlan, kind: "team" },
    ];
    for (const body of bodies) {
      const res = await t.api("POST", "/v1/plans", { apiKey: a.apiKey, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("keeps predefined plans read-only (403 PLAN_READ_ONLY)", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const res = await t.api("PATCH", `/v1/plans/${PLAN_IDS.starter}`, {
      apiKey: a.apiKey,
      body: { monthlyAllowance: 999_999 },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PLAN_READ_ONLY");

    const still = await t.api("GET", `/v1/plans/${PLAN_IDS.starter}`, { apiKey: a.apiKey });
    expect(still.body.monthlyAllowance).toBe(5000);
  });

  it("hides another account's custom plan and refuses to assign it", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const b = await createAccountViaApi(t.api, "B");
    const plan = await t.api("POST", "/v1/plans", { apiKey: a.apiKey, body: teamPlan });
    const planId = plan.body.id as string;

    const read = await t.api("GET", `/v1/plans/${planId}`, { apiKey: b.apiKey });
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("PLAN_NOT_FOUND");

    const patch = await t.api("PATCH", `/v1/plans/${planId}`, {
      apiKey: b.apiKey,
      body: { monthlyAllowance: 1 },
    });
    expect(patch.status).toBe(404);

    await t.api("POST", "/v1/users", { apiKey: b.apiKey, body: { userId: "b1" } });
    const assign = await t.api("PUT", "/v1/users/b1/plan", {
      apiKey: b.apiKey,
      body: { planId },
    });
    expect(assign.status).toBe(404);

    const unchanged = await t.api("GET", `/v1/plans/${planId}`, { apiKey: a.apiKey });
    expect(unchanged.body.monthlyAllowance).toBe(100);
  });

  it("returns 404 for a well-formed but unknown plan id, 400 for a malformed one", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const unknown = await t.api("GET", `/v1/plans/${randomUUID()}`, { apiKey: a.apiKey });
    expect(unknown.status).toBe(404);
    const malformed = await t.api("GET", "/v1/plans/not-a-uuid", { apiKey: a.apiKey });
    expect(malformed.status).toBe(400);
  });

  it("one shared plan definition: updating it changes the limits seen by every assigned user", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const plan = await t.api("POST", "/v1/plans", { apiKey: a.apiKey, body: teamPlan });
    const planId = plan.body.id as string;
    for (const userId of ["u1", "u2"]) {
      const res = await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId, planId } });
      expect(res.status).toBe(201);
    }

    const upd = await t.api("PATCH", `/v1/plans/${planId}`, {
      apiKey: a.apiKey,
      body: { monthlyAllowance: 250 },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.monthlyAllowance).toBe(250);
    expect(upd.body.maxPerRequest).toBe(10); // untouched fields are preserved

    for (const userId of ["u1", "u2"]) {
      const u = await t.api("GET", `/v1/users/${userId}`, { apiKey: a.apiKey });
      expect(u.body.plan.id).toBe(planId);
      expect(u.body.plan.monthlyAllowance).toBe(250);
    }
  });

  it("rejects empty patches and unknown fields (e.g. changing kind)", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const plan = await t.api("POST", "/v1/plans", { apiKey: a.apiKey, body: teamPlan });
    const planId = plan.body.id as string;

    const empty = await t.api("PATCH", `/v1/plans/${planId}`, { apiKey: a.apiKey, body: {} });
    expect(empty.status).toBe(400);

    const kind = await t.api("PATCH", `/v1/plans/${planId}`, {
      apiKey: a.apiKey,
      body: { kind: "account" },
    });
    expect(kind.status).toBe(400);
  });
});
