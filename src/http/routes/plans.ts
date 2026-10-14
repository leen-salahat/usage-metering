import { Router } from "express";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  createCustomPlan,
  getPlan,
  listPlans,
  updateCustomPlan,
} from "../../services/plans.js";
import { asyncHandler, parseOrThrow } from "../errors.js";
import { currentAccount } from "../middleware/auth.js";
import {
  maxPerRequestSchema,
  monthlyAllowanceSchema,
  nameSchema,
  planKindSchema,
  uuidSchema,
} from "../schemas.js";

const listQuerySchema = z.object({ kind: planKindSchema.optional() });

const createPlanSchema = z.object({
  kind: planKindSchema,
  name: nameSchema,
  monthlyAllowance: monthlyAllowanceSchema,
  maxPerRequest: maxPerRequestSchema,
});

// .strict(): unknown fields (e.g. trying to change "kind") are rejected, not silently ignored.
const updatePlanSchema = z
  .object({
    name: nameSchema.optional(),
    monthlyAllowance: monthlyAllowanceSchema.optional(),
    maxPerRequest: maxPerRequestSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update." });

export function plansRouter(db: Db) {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const { kind } = parseOrThrow(listQuerySchema, req.query);
      res.json({ plans: await listPlans(db, account.id, kind) });
    }),
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const input = parseOrThrow(createPlanSchema, req.body);
      res.status(201).json(await createCustomPlan(db, account.id, input));
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const id = parseOrThrow(uuidSchema, req.params.id);
      res.json(await getPlan(db, account.id, id));
    }),
  );

  router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const id = parseOrThrow(uuidSchema, req.params.id);
      const patch = parseOrThrow(updatePlanSchema, req.body);
      res.json(await updateCustomPlan(db, account.id, id, patch));
    }),
  );

  return router;
}
