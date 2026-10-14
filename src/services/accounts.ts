import { eq } from "drizzle-orm";
import { generateApiKey, hashApiKey } from "../domain/apikey.js";
import type { Db } from "../db/client.js";
import { accounts, plans } from "../db/schema.js";
import { AppError } from "../errors.js";
import { findAssignablePlan, toPlanDto } from "./plans.js";

type AccountRow = typeof accounts.$inferSelect;
type PlanRow = typeof plans.$inferSelect;

export function toAccountDto(a: AccountRow, plan: PlanRow) {
  return {
    id: a.id,
    name: a.name,
    createdAt: a.createdAt.toISOString(),
    plan: toPlanDto(plan),
  };
}

/** Creates an account and its API key. The raw key is returned here and never stored. */
export async function createAccount(db: Db, input: { name: string; planId: string }) {
  // A brand-new account has no custom plans yet, so only predefined account plans qualify.
  const plan = await findAssignablePlan(db, null, input.planId, "account");
  const { key, hash, prefix } = generateApiKey();
  const [row] = await db
    .insert(accounts)
    .values({ name: input.name, apiKeyHash: hash, apiKeyPrefix: prefix, planId: plan.id })
    .returning();
  return { account: toAccountDto(row, plan), apiKey: key, apiKeyPrefix: prefix };
}

/** Used by the auth middleware: hash the presented key and look it up by its unique hash. */
export async function findAccountByApiKey(db: Db, rawKey: string) {
  const [row] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.apiKeyHash, hashApiKey(rawKey)))
    .limit(1);
  return row ?? null;
}

export async function getAccount(db: Db, accountId: string) {
  const [row] = await db
    .select({ account: accounts, plan: plans })
    .from(accounts)
    .innerJoin(plans, eq(accounts.planId, plans.id))
    .where(eq(accounts.id, accountId));
  if (!row) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
  return toAccountDto(row.account, row.plan);
}

export async function setAccountPlan(db: Db, accountId: string, planId: string) {
  const plan = await findAssignablePlan(db, accountId, planId, "account");
  await db.update(accounts).set({ planId: plan.id }).where(eq(accounts.id, accountId));
  return getAccount(db, accountId);
}
