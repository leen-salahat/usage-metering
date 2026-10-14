import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import { createAccountViaApi, setupTestApp } from "../helpers/app.js";

describe("users and account isolation", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("registers a user with the default Basic plan", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const res = await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId: "u1" } });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe("u1");
    expect(res.body.plan.id).toBe(PLAN_IDS.basic);
  });

  it("registers a user with an explicit Premium plan", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const res = await t.api("POST", "/v1/users", {
      apiKey: a.apiKey,
      body: { userId: "vip", planId: PLAN_IDS.premium },
    });
    expect(res.status).toBe(201);
    expect(res.body.plan.name).toBe("Premium");
  });

  it("rejects a duplicate userId inside the same account (409)", async () => {
    const a = await createAccountViaApi(t.api, "A");
    await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId: "u1" } });
    const dup = await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId: "u1" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("USER_ALREADY_EXISTS");
  });

  it("allows the same userId in two different accounts, as independent users", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const b = await createAccountViaApi(t.api, "B");
    const ra = await t.api("POST", "/v1/users", {
      apiKey: a.apiKey,
      body: { userId: "shared-id", planId: PLAN_IDS.premium },
    });
    const rb = await t.api("POST", "/v1/users", { apiKey: b.apiKey, body: { userId: "shared-id" } });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.plan.name).toBe("Premium");
    expect(rb.body.plan.name).toBe("Basic");
  });

  it("rejects invalid userIds (empty, spaces, too long, wrong type)", async () => {
    const a = await createAccountViaApi(t.api, "A");
    for (const userId of ["", "has space", "x".repeat(129), 123]) {
      const res = await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("requires an API key for every user endpoint", async () => {
    for (const [method, path] of [
      ["POST", "/v1/users"],
      ["GET", "/v1/users"],
      ["GET", "/v1/users/u1"],
      ["PUT", "/v1/users/u1/plan"],
    ] as const) {
      const res = await t.api(method, path);
      expect(res.status).toBe(401);
    }
  });

  it("lists only the calling account's users", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const b = await createAccountViaApi(t.api, "B");
    await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId: "a1" } });
    await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId: "a2" } });
    await t.api("POST", "/v1/users", { apiKey: b.apiKey, body: { userId: "b1" } });

    const listA = await t.api("GET", "/v1/users", { apiKey: a.apiKey });
    const listB = await t.api("GET", "/v1/users", { apiKey: b.apiKey });
    expect(listA.body.users.map((u: { userId: string }) => u.userId)).toEqual(["a1", "a2"]);
    expect(listB.body.users.map((u: { userId: string }) => u.userId)).toEqual(["b1"]);
  });

  it("hides another account's user (404) and refuses to change its plan", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const b = await createAccountViaApi(t.api, "B");
    await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId: "secret" } });

    const read = await t.api("GET", "/v1/users/secret", { apiKey: b.apiKey });
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("USER_NOT_FOUND");

    const write = await t.api("PUT", "/v1/users/secret/plan", {
      apiKey: b.apiKey,
      body: { planId: PLAN_IDS.premium },
    });
    expect(write.status).toBe(404);

    const unchanged = await t.api("GET", "/v1/users/secret", { apiKey: a.apiKey });
    expect(unchanged.body.plan.name).toBe("Basic");
  });

  it("switches a user's plan, and rejects an account plan for a user", async () => {
    const a = await createAccountViaApi(t.api, "A");
    await t.api("POST", "/v1/users", { apiKey: a.apiKey, body: { userId: "u1" } });

    const ok = await t.api("PUT", "/v1/users/u1/plan", {
      apiKey: a.apiKey,
      body: { planId: PLAN_IDS.premium },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.plan.name).toBe("Premium");

    const bad = await t.api("PUT", "/v1/users/u1/plan", {
      apiKey: a.apiKey,
      body: { planId: PLAN_IDS.pro },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PLAN_KIND_MISMATCH");
  });
});
