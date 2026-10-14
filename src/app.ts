import express from "express";
import type { Db } from "./db/client.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { requireApiKey } from "./http/middleware/auth.js";
import { accountRouter, publicAccountsRouter } from "./http/routes/accounts.js";
import { usersRouter } from "./http/routes/users.js";

export function createApp(deps: { db: Db }) {
  const { db } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const v1 = express.Router();
  v1.use("/accounts", publicAccountsRouter(db)); // public: bootstrap
  v1.use(requireApiKey(db)); // everything below needs a valid API key
  v1.use("/account", accountRouter(db));
  v1.use("/users", usersRouter(db));
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
