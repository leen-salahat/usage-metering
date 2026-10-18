import { config } from "./config.js";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { seedPredefinedPlans } from "./db/seed.js";
import { waitForDb } from "./db/wait.js";

const { pool, db } = createDb(config.DATABASE_URL);

// An idle pooled connection can emit an error (e.g. Postgres restarts). Log it instead of crashing.
pool.on("error", (err) => console.error("Idle database client error:", err.message));

await waitForDb(pool);
console.log("Database is reachable.");
await runMigrations(db);
console.log("Migrations applied.");
await seedPredefinedPlans(db);
console.log("Predefined plans ready.");

const app = createApp({ db });
const server = app.listen(config.PORT, () => {
  console.log(`Metering service listening on port ${config.PORT}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received: no new connections, finishing in-flight requests...`);
  // close() waits for running requests (and so their transactions) to finish.
  server.close(async () => {
    await pool.end();
    console.log("Shutdown complete.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Forced shutdown after 10s.");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
