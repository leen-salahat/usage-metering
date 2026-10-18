import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createDb } from "../../src/db/client.js";
import { setupTestApp } from "../helpers/app.js";

describe("health and readiness", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;

  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("/health reports liveness", async () => {
    const res = await t.api("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("/ready is ready when the database answers", async () => {
    const res = await t.api("GET", "/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
  });

  it("/ready returns 503 when the database is unreachable, while /health stays 200", async () => {
    const { pool, db } = createDb("postgres://nobody:nobody@127.0.0.1:1/none"); // nothing listens on port 1
    pool.on("error", () => {});
    const server: Server = await new Promise((resolve) => {
      const s = createApp({ db }).listen(0, () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "unavailable" });
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  });
});
