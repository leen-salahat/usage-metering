import { z } from "zod";

export const uuidSchema = z.string().uuid();

/** The calling app's own user identifier. Restricted charset keeps URLs and logs sane. */
export const userIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.@:-]+$/, "userId may only contain letters, digits and _ . @ : -");

export const nameSchema = z.string().trim().min(1).max(100);
export const planKindSchema = z.enum(["account", "user"]);

// Whole numbers only: fractional and non-numeric values are rejected (no coercion).
export const monthlyAllowanceSchema = z.number().int().min(0).max(1_000_000_000_000);
export const maxPerRequestSchema = z.number().int().min(1).max(2_147_483_647);

// Positive whole numbers only; the upper bound matches the INTEGER column of usage_requests.units.
export const unitsSchema = z.number().int().min(1).max(2_147_483_647);

/** Caller-chosen idempotency key. Same charset as userId, 1-128 chars (also enforced by a DB CHECK). */
export const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.@:-]+$/, "requestId may only contain letters, digits and _ . @ : -");
