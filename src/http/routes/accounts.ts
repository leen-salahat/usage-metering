import { Router } from "express";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { PLAN_IDS } from "../../db/seed.js";
import { createAccount, getAccount, setAccountPlan } from "../../services/accounts.js";
import { asyncHandler, parseOrThrow } from "../errors.js";
import { currentAccount } from "../middleware/auth.js";
import { nameSchema, uuidSchema } from "../schemas.js";

const createAccountSchema = z.object({
  name: nameSchema,
  planId: uuidSchema.optional(),
});

const setPlanSchema = z.object({ planId: uuidSchema });

/** POST /v1/accounts: public bootstrap endpoint (an account cannot have a key before it exists). */
export function publicAccountsRouter(db: Db) {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const input = parseOrThrow(createAccountSchema, req.body);
      const result = await createAccount(db, {
        name: input.name,
        planId: input.planId ?? PLAN_IDS.starter,
      });
      res.status(201).set("Cache-Control", "no-store").json(result);
    }),
  );

  return router;
}

/** Authenticated endpoints about the calling account itself. */
export function accountRouter(db: Db) {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      res.json(await getAccount(db, account.id));
    }),
  );

  router.put(
    "/plan",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const { planId } = parseOrThrow(setPlanSchema, req.body);
      res.json(await setAccountPlan(db, account.id, planId));
    }),
  );

  return router;
}
