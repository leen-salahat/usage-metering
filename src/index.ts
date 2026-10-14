import { config } from "./config.js";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { seedPredefinedPlans } from "./db/seed.js";

const { db } = createDb(config.DATABASE_URL);

await runMigrations(db);
await seedPredefinedPlans(db);

const app = createApp({ db });
app.listen(config.PORT, () => {
  console.log(`Metering service listening on port ${config.PORT}`);
});
