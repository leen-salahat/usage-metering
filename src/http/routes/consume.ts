import { Router } from "express";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { consume } from "../../services/consumption.js";
import { asyncHandler, parseOrThrow } from "../errors.js";
import { currentAccount } from "../middleware/auth.js";
import { requestIdSchema, unitsSchema, userIdSchema } from "../schemas.js";

// Note: no accountId here. The account is ALWAYS the one identified by the API key.
const consumeSchema = z.object({
  userId: userIdSchema,
  units: unitsSchema,
  requestId: requestIdSchema,
});

export function consumeRouter(db: Db, now: () => Date) {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const account = currentAccount(req);
      const input = parseOrThrow(consumeSchema, req.body);
      // A business rejection is a decision, not an error: it is returned with HTTP 200.
      res.status(200).json(await consume(db, { accountId: account.id, ...input }, now()));
    }),
  );

  return router;
}
