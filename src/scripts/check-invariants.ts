import { config } from "../config.js";
import { createDb } from "../db/client.js";
import { findInvariantViolations } from "../db/invariants.js";

const { pool } = createDb(config.DATABASE_URL);
try {
  const { checked, violations } = await findInvariantViolations(pool);
  if (violations.length === 0) {
    console.log(`OK: ${checked} account-month(s) checked, all invariants hold.`);
  } else {
    console.error(`FAIL: ${violations.length} of ${checked} account-month(s) violate the invariants:`);
    console.table(violations);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
