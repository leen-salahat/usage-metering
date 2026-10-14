import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import { createAccountViaApi, setupTestApp } from "../helpers/app.js";

describe("accounts and API key authentication", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("creates an account, returns the raw key once, and defaults to the Starter plan", async () => {
    const res = await t.api("POST", "/v1/accounts", { body: { name: "Acme" } });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^mk_[A-Za-z0-9_-]{43}$/);
    expect(res.body.account.name).toBe("Acme");
    expect(res.body.account.plan.id).toBe(PLAN_IDS.starter);
    expect(res.body.account.plan.name).toBe("Starter");
  });

  it("stores only a hash of the key, never the raw key", async () => {
    const { id, apiKey } = await createAccountViaApi(t.api, "HashCheck");
    const { rows } = await t.pool.query(
      "SELECT api_key_hash, api_key_prefix FROM accounts WHERE id = $1",
      [id],
    );
    expect(rows[0].api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].api_key_hash).not.toBe(apiKey);
    expect(rows[0].api_key_prefix).toBe(apiKey.slice(0, 8));
    const leak = await t.pool.query(
      "SELECT count(*)::int AS n FROM accounts WHERE api_key_hash = $1 OR api_key_prefix = $1",
      [apiKey],
    );
    expect(leak.rows[0].n).toBe(0);
  });

  it("accepts a predefined account plan (Pro) at creation", async () => {
    const res = await t.api("POST", "/v1/accounts", {
      body: { name: "BigCo", planId: PLAN_IDS.pro },
    });
    expect(res.status).toBe(201);
    expect(res.body.account.plan.name).toBe("Pro");
  });

  it("rejects a user plan as the account plan (PLAN_KIND_MISMATCH)", async () => {
    const res = await t.api("POST", "/v1/accounts", {
      body: { name: "Bad", planId: PLAN_IDS.basic },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PLAN_KIND_MISMATCH");
  });

  it("rejects an unknown plan id (PLAN_NOT_FOUND)", async () => {
    const res = await t.api("POST", "/v1/accounts", {
      body: { name: "Ghost", planId: randomUUID() },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PLAN_NOT_FOUND");
  });

  it("rejects an invalid body with VALIDATION_ERROR and details", async () => {
    const res = await t.api("POST", "/v1/accounts", { body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it("rejects malformed JSON with INVALID_JSON", async () => {
    const res = await t.api("POST", "/v1/accounts", { rawBody: "{not json" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("returns 401 MISSING_API_KEY when the header is absent", async () => {
    const res = await t.api("GET", "/v1/account");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: "MISSING_API_KEY", message: "Missing X-API-Key header." },
    });
  });

  it("returns 401 INVALID_API_KEY for a wrong key", async () => {
    const res = await t.api("GET", "/v1/account", { apiKey: "mk_definitely-not-a-real-key" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_API_KEY");
  });

  it("identifies the calling account from its key (each key sees only its own account)", async () => {
    const a = await createAccountViaApi(t.api, "A");
    const b = await createAccountViaApi(t.api, "B");
    const resA = await t.api("GET", "/v1/account", { apiKey: a.apiKey });
    const resB = await t.api("GET", "/v1/account", { apiKey: b.apiKey });
    expect(resA.status).toBe(200);
    expect(resA.body.id).toBe(a.id);
    expect(resB.body.id).toBe(b.id);
  });

  it("switches the account plan, and rejects a user plan", async () => {
    const a = await createAccountViaApi(t.api, "Switcher");
    const ok = await t.api("PUT", "/v1/account/plan", {
      apiKey: a.apiKey,
      body: { planId: PLAN_IDS.pro },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.plan.name).toBe("Pro");

    const bad = await t.api("PUT", "/v1/account/plan", {
      apiKey: a.apiKey,
      body: { planId: PLAN_IDS.premium },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PLAN_KIND_MISMATCH");
  });

  it("returns 404 ROUTE_NOT_FOUND for unknown routes", async () => {
    const res = await t.api("GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});
