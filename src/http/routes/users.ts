import { Router } from "express";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { createUser, getUser, listUsers, setUserPlan } from "../../services/users.js";
import { asyncHandler, parseOrThrow } from "../errors.js";
import { currentAccount } from "../middleware/auth.js";
import { userIdSchema, uuidSchema } from "../schemas.js";

const createUserSchema = z.object({
  userId: userIdSchema,
  planId: uuidSchema.optional(),
});
const setPlanSchema = z.object({ planId: uuidSchema });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function usersRouter(db: Db) {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const input = parseOrThrow(createUserSchema, req.body);
      res.status(201).json(await createUser(db, account.id, input));
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const { limit } = parseOrThrow(listQuerySchema, req.query);
      res.json({ users: await listUsers(db, account.id, limit) });
    }),
  );

  router.get(
    "/:userId",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const userId = parseOrThrow(userIdSchema, req.params.userId);
      res.json(await getUser(db, account.id, userId));
    }),
  );

  router.put(
    "/:userId/plan",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const userId = parseOrThrow(userIdSchema, req.params.userId);
      const { planId } = parseOrThrow(setPlanSchema, req.body);
      res.json(await setUserPlan(db, account.id, userId, planId));
    }),
  );

  return router;
}
