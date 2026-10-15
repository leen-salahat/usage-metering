import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createTestDb, resetDatabase } from "./db.js";

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface ApiOptions {
  apiKey?: string;
  body?: unknown;
  rawBody?: string;
}

export type Api = (method: string, path: string, opts?: ApiOptions) => Promise<ApiResult>;

export const DEFAULT_TEST_NOW = "2026-10-15T10:00:00.000Z";

async function startTestServer(db: Db, now: () => Date) {
  const app = createApp({ db, now });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s)); // port 0 = any free port
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function makeApi(baseUrl: string): Api {
  return async (method, path, opts = {}) => {
    const headers: Record<string, string> = {};
    if (opts.apiKey !== undefined) headers["x-api-key"] = opts.apiKey;
    let body: string | undefined;
    if (opts.rawBody !== undefined) {
      headers["content-type"] = "application/json";
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(baseUrl + path, { method, headers, body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

/** Fresh schema + seeded plans + running HTTP server + a controllable clock. One call per test file. */
export async function setupTestApp() {
  const { pool, db } = createTestDb();
  await resetDatabase(pool);
  await runMigrations(db);
  await seedPredefinedPlans(db);

  let current = new Date(DEFAULT_TEST_NOW);
  const clock = {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso);
    },
    reset: () => {
      current = new Date(DEFAULT_TEST_NOW);
    },
  };

  const server = await startTestServer(db, clock.now);
  const api = makeApi(server.baseUrl);
  return {
    pool,
    db,
    api,
    clock,
    async close() {
      await server.close();
      await pool.end();
    },
  };
}

/** Creates an account through the real API and returns its id and raw API key. */
export async function createAccountViaApi(api: Api, name = "Acme", planId?: string) {
  const res = await api("POST", "/v1/accounts", { body: planId ? { name, planId } : { name } });
  if (res.status !== 201) {
    throw new Error(`createAccount failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.account.id as string, apiKey: res.body.apiKey as string };
}
