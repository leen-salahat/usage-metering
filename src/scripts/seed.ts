import { config } from "../config.js";
import { createDb } from "../db/client.js";
import { seedPredefinedPlans } from "../db/seed.js";

const { pool, db } = createDb(config.DATABASE_URL);
try {
  await seedPredefinedPlans(db);
  console.log("Predefined plans seeded.");
} finally {
  await pool.end();
}
