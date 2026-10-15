import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type ApiResult } from "../helpers/app.js";
import { consume, setupScenario } from "../helpers/fixtures.js";

const ids = (res: ApiResult): string[] =>
  res.body.requests.map((r: { requestId: string }) => r.requestId);

describe("request history", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  beforeEach(() => t.clock.reset());
  afterAll(async () => {
    await t.close();
  });

  const send = (key: string, userId: string, units: number, requestId: string) =>
    consume(t.api, key, { userId, units, requestId });

  it("lists outcomes newest first, rejected ones included, with the decision snapshot", async () => {
    const s = await setupScenario(t.api);
    await send(s.apiKey, "alice", 10, "a-1"); // accepted
    await send(s.apiKey, "alice", 25, "a-2"); // rejected: user per-request limit
    await send(s.apiKey, "bob", 5, "a-3"); // accepted

    const res = await t.api("GET", "/v1/requests", { apiKey: s.apiKey });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["a-3", "a-2", "a-1"]);
    expect(res.body.nextCursor).toBeNull();

    expect(res.body.requests[1]).toMatchObject({
      requestId: "a-2",
      userId: "alice",
      units: 25,
      accepted: false,
      reason: "PER_REQUEST_LIMIT_EXCEEDED",
      scope: "user",
      period: "2026-10",
    });
    expect(res.body.requests[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(res.body.requests[2].user).toMatchObject({ consumed: 10, monthlyAllowance: 60 });
    expect(res.body.requests[2].account).toMatchObject({ consumed: 10, monthlyAllowance: 100 });
  });

  it("paginates with an opaque cursor, with no gaps and no duplicates", async () => {
    const s = await setupScenario(t.api);
    for (let i = 1; i <= 7; i++) await send(s.apiKey, "alice", 1, `p-${i}`);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/requests?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res: ApiResult = await t.api("GET", url, { apiKey: s.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.requests.length).toBeLessThanOrEqual(3);
      seen.push(...ids(res));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3); // 3 + 3 + 1
    expect(seen).toEqual(["p-7", "p-6", "p-5", "p-4", "p-3", "p-2", "p-1"]);

    // exact multiples: asking for everything must not invent another page
    const all = await t.api("GET", "/v1/requests?limit=7", { apiKey: s.apiKey });
    expect(all.body.requests).toHaveLength(7);
    expect(all.body.nextCursor).toBeNull();
    const six = await t.api("GET", "/v1/requests?limit=6", { apiKey: s.apiKey });
    expect(six.body.requests).toHaveLength(6);
    expect(six.body.nextCursor).not.toBeNull();
  });

  it("filters by userId and by accepted", async () => {
    const s = await setupScenario(t.api);
    await send(s.apiKey, "alice", 10, "f-1");
    await send(s.apiKey, "alice", 25, "f-2"); // rejected
    await send(s.apiKey, "bob", 5, "f-3");
    await send(s.apiKey, "bob", 30, "f-4"); // rejected

    const alice = await t.api("GET", "/v1/requests?userId=alice", { apiKey: s.apiKey });
    expect(ids(alice)).toEqual(["f-2", "f-1"]);
    const rejected = await t.api("GET", "/v1/requests?accepted=false", { apiKey: s.apiKey });
    expect(ids(rejected)).toEqual(["f-4", "f-2"]);
    const bobOk = await t.api("GET", "/v1/requests?userId=bob&accepted=true", { apiKey: s.apiKey });
    expect(ids(bobOk)).toEqual(["f-3"]);

    const bad = await t.api("GET", "/v1/requests?accepted=maybe", { apiKey: s.apiKey });
    expect(bad.status).toBe(400);
  });

  it("rejects invalid pagination parameters", async () => {
    const s = await setupScenario(t.api);
    for (const q of ["limit=0", "limit=501", "limit=abc"]) {
      const res = await t.api("GET", `/v1/requests?${q}`, { apiKey: s.apiKey });
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    const garbage = await t.api("GET", "/v1/requests?cursor=garbage", { apiKey: s.apiKey });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe("INVALID_CURSOR");

    const wrongShape = Buffer.from(JSON.stringify({ t: "x", id: "y" })).toString("base64url");
    const shape = await t.api("GET", `/v1/requests?cursor=${wrongShape}`, { apiKey: s.apiKey });
    expect(shape.status).toBe(400);
    expect(shape.body.error.code).toBe("INVALID_CURSOR");

    const max = await t.api("GET", "/v1/requests?limit=500", { apiKey: s.apiKey });
    expect(max.status).toBe(200);
  });

  it("isolates accounts: only your own history, and a foreign request id is 404", async () => {
    const a = await setupScenario(t.api, "A");
    const b = await setupScenario(t.api, "B");
    await send(a.apiKey, "alice", 10, "iso-1");
    await send(b.apiKey, "alice", 10, "iso-2");

    const listB = await t.api("GET", "/v1/requests", { apiKey: b.apiKey });
    expect(ids(listB)).toEqual(["iso-2"]);

    const foreign = await t.api("GET", "/v1/requests/iso-1", { apiKey: b.apiKey });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("REQUEST_NOT_FOUND");
    const own = await t.api("GET", "/v1/requests/iso-1", { apiKey: a.apiKey });
    expect(own.status).toBe(200);
  });

  it("GET /requests/:requestId returns the stored outcome, unchanged by later plan updates", async () => {
    const s = await setupScenario(t.api);
    await send(s.apiKey, "alice", 25, "keep-1"); // rejected: max per request is 20
    await t.api("PATCH", `/v1/plans/${s.userPlanId}`, { apiKey: s.apiKey, body: { maxPerRequest: 100 } });

    const res = await t.api("GET", "/v1/requests/keep-1", { apiKey: s.apiKey });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: false, reason: "PER_REQUEST_LIMIT_EXCEEDED", scope: "user" });
    expect(res.body.user.maxPerRequest).toBe(20); // the limit at decision time, not the current 100

    const unknown = await t.api("GET", "/v1/requests/never-sent", { apiKey: s.apiKey });
    expect(unknown.status).toBe(404);
  });

  it("requires an API key", async () => {
    for (const path of ["/v1/requests", "/v1/requests/x"]) {
      const res = await t.api("GET", path);
      expect(res.status, path).toBe(401);
    }
  });
});
