import express from "express";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { requireApiKey } from "./http/middleware/auth.js";
import { accountRouter, publicAccountsRouter } from "./http/routes/accounts.js";
import { consumeRouter } from "./http/routes/consume.js";
import { plansRouter } from "./http/routes/plans.js";
import { requestsRouter } from "./http/routes/requests.js";
import { usageRouter } from "./http/routes/usage.js";
import { usersRouter } from "./http/routes/users.js";

export function createApp(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date()); // tests inject a fake clock
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // Liveness: the process is up. Deliberately does not touch the database.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: the service can really serve requests, i.e. the database answers.
  app.get("/ready", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ready" });
    } catch (err) {
      console.error("Readiness check failed:", (err as Error).message);
      res.status(503).json({ status: "unavailable" });
    }
  });

  const v1 = express.Router();
  v1.use("/accounts", publicAccountsRouter(db)); // public: bootstrap
  v1.use(requireApiKey(db)); // everything below needs a valid API key
  v1.use("/account", accountRouter(db));
  v1.use("/users", usersRouter(db));
  v1.use("/plans", plansRouter(db));
  v1.use("/consume", consumeRouter(db, now));
  v1.use(usageRouter(db, now)); // /usage, /usage/history, /users/:id/usage[/history]
  v1.use("/requests", requestsRouter(db));
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
