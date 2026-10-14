import "dotenv/config";
import type pg from "pg";
import { createDb } from "../../src/db/client.js";

export function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  // Safety guard: never wipe a non-test database by accident.
  if (!new URL(url).pathname.includes("test")) {
    throw new Error("TEST_DATABASE_URL must point to a database whose name contains 'test'");
  }
  return createDb(url);
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
}
