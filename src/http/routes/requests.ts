import { Router } from "express";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { getRequest, listRequests } from "../../services/requests.js";
import { asyncHandler, parseOrThrow } from "../errors.js";
import { currentAccount } from "../middleware/auth.js";
import { requestIdSchema, userIdSchema } from "../schemas.js";

const listQuerySchema = z.object({
  userId: userIdSchema.optional(),
  accepted: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export function requestsRouter(db: Db) {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const query = parseOrThrow(listQuerySchema, req.query);
      res.json(await listRequests(db, account.id, query));
    }),
  );

  router.get(
    "/:requestId",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const requestId = parseOrThrow(requestIdSchema, req.params.requestId);
      res.json(await getRequest(db, account.id, requestId));
    }),
  );

  return router;
}
