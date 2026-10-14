import { config } from "../config.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";

const { pool, db } = createDb(config.DATABASE_URL);
try {
  await runMigrations(db);
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
