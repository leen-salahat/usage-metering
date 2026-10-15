import { Router } from "express";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  getAccountMonths,
  getAccountUsage,
  getUserMonths,
  getUserUsage,
} from "../../services/usage.js";
import { asyncHandler, parseOrThrow } from "../errors.js";
import { currentAccount } from "../middleware/auth.js";
import { userIdSchema } from "../schemas.js";

const monthsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
});

/** Mounted at the /v1 root; every path below is already behind requireApiKey. */
export function usageRouter(db: Db, now: () => Date) {
  const router = Router();

  router.get(
    "/usage",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      res.json(await getAccountUsage(db, account.id, now()));
    }),
  );

  router.get(
    "/usage/history",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const { limit } = parseOrThrow(monthsQuerySchema, req.query);
      res.json({ months: await getAccountMonths(db, account.id, limit) });
    }),
  );

  router.get(
    "/users/:userId/usage",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const userId = parseOrThrow(userIdSchema, req.params.userId);
      res.json(await getUserUsage(db, account.id, userId, now()));
    }),
  );

  router.get(
    "/users/:userId/usage/history",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const userId = parseOrThrow(userIdSchema, req.params.userId);
      const { limit } = parseOrThrow(monthsQuerySchema, req.query);
      res.json({ userId, months: await getUserMonths(db, account.id, userId, limit) });
    }),
  );

  return router;
}
