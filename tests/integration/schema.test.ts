import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { PLAN_IDS, seedPredefinedPlans } from "../../src/db/seed.js";
import { createTestDb, resetDatabase } from "../helpers/db.js";

describe("schema, migrations and seed", () => {
  const { pool, db } = createTestDb();

  beforeAll(async () => {
    await resetDatabase(pool);
    await runMigrations(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("seeds exactly the 4 predefined plans, even when run twice", async () => {
    await seedPredefinedPlans(db);
    await seedPredefinedPlans(db);

    const { rows } = await pool.query(
      `SELECT kind, name, monthly_allowance::int AS monthly, max_per_request
       FROM plans WHERE is_predefined ORDER BY kind, name`,
    );

    expect(rows).toEqual([
      { kind: "account", name: "Pro", monthly: 100000, max_per_request: 1000 },
      { kind: "account", name: "Starter", monthly: 5000, max_per_request: 100 },
      { kind: "user", name: "Basic", monthly: 500, max_per_request: 20 },
      { kind: "user", name: "Premium", monthly: 5000, max_per_request: 100 },
    ]);
  });

  it("rejects max_per_request = 0", async () => {
    await expect(
      pool.query(
        `INSERT INTO plans (kind, name, monthly_allowance, max_per_request, is_predefined)
         VALUES ('user', 'Bad', 10, 0, true)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an invalid plan kind", async () => {
    await expect(
      pool.query(
        `INSERT INTO plans (kind, name, monthly_allowance, max_per_request, is_predefined)
         VALUES ('team', 'Bad', 10, 5, true)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a duplicate predefined plan name within the same kind", async () => {
    await expect(
      pool.query(
        `INSERT INTO plans (kind, name, monthly_allowance, max_per_request, is_predefined)
         VALUES ('account', 'Starter', 1, 1, true)`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects is_predefined = false without an owner account", async () => {
    await expect(
      pool.query(
        `INSERT INTO plans (kind, name, monthly_allowance, max_per_request, is_predefined)
         VALUES ('user', 'Orphan', 10, 5, false)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects negative usage", async () => {
    const acc = await pool.query(
      `INSERT INTO accounts (name, api_key_hash, api_key_prefix, plan_id)
       VALUES ('Test', 'hash-1', 'mk_abcd', $1) RETURNING id`,
      [PLAN_IDS.starter],
    );
    await expect(
      pool.query(
        `INSERT INTO account_usage (account_id, period_start, consumed) VALUES ($1, '2026-10-01', -1)`,
        [acc.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects usage for a user that does not exist under that account", async () => {
    const acc = await pool.query(`SELECT id FROM accounts WHERE api_key_hash = 'hash-1'`);
    await expect(
      pool.query(
        `INSERT INTO user_usage (account_id, user_id, period_start, consumed)
         VALUES ($1, 'ghost', '2026-10-01', 0)`,
        [acc.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
