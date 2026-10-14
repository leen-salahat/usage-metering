import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pgErrorCode } from "../db/errors.js";
import { plans } from "../db/schema.js";
import { AppError } from "../errors.js";

export type PlanKind = "account" | "user";
type PlanRow = typeof plans.$inferSelect;

export function toPlanDto(p: PlanRow) {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    monthlyAllowance: p.monthlyAllowance,
    maxPerRequest: p.maxPerRequest,
    isPredefined: p.isPredefined,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Predefined plans are visible to everyone; custom plans only to their owner account. */
function visibleTo(accountId: string | null) {
  return accountId === null
    ? isNull(plans.accountId)
    : or(isNull(plans.accountId), eq(plans.accountId, accountId));
}

/** Returns the plan if the account may see it; otherwise 404 (never reveals other accounts' plans). */
export async function findVisiblePlan(db: Db, accountId: string | null, planId: string) {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), visibleTo(accountId)));
  if (!plan) throw new AppError(404, "PLAN_NOT_FOUND", "Plan not found.");
  return plan;
}

/** A plan can be assigned only if it is visible to the account AND of the right kind. */
export async function findAssignablePlan(
  db: Db,
  accountId: string | null,
  planId: string,
  kind: PlanKind,
) {
  const plan = await findVisiblePlan(db, accountId, planId);
  if (plan.kind !== kind) {
    throw new AppError(
      400,
      "PLAN_KIND_MISMATCH",
      `Plan "${plan.name}" is a ${plan.kind} plan and cannot be assigned to a ${kind}.`,
    );
  }
  return plan;
}

export async function listPlans(db: Db, accountId: string, kind?: PlanKind) {
  const rows = await db
    .select()
    .from(plans)
    .where(and(visibleTo(accountId), kind ? eq(plans.kind, kind) : undefined))
    .orderBy(desc(plans.isPredefined), asc(plans.kind), asc(plans.name));
  return rows.map(toPlanDto);
}

export async function getPlan(db: Db, accountId: string, planId: string) {
  return toPlanDto(await findVisiblePlan(db, accountId, planId));
}

export async function createCustomPlan(
  db: Db,
  accountId: string,
  input: { kind: PlanKind; name: string; monthlyAllowance: number; maxPerRequest: number },
) {
  try {
    const [row] = await db
      .insert(plans)
      .values({ accountId, isPredefined: false, ...input })
      .returning();
    return toPlanDto(row);
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      throw new AppError(
        409,
        "PLAN_NAME_TAKEN",
        `You already have a ${input.kind} plan named "${input.name}".`,
      );
    }
    throw err;
  }
}

export async function updateCustomPlan(
  db: Db,
  accountId: string,
  planId: string,
  patch: { name?: string; monthlyAllowance?: number; maxPerRequest?: number },
) {
  const plan = await findVisiblePlan(db, accountId, planId);
  if (plan.isPredefined) {
    throw new AppError(403, "PLAN_READ_ONLY", "Predefined plans cannot be modified.");
  }
  try {
    const [row] = await db
      .update(plans)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(plans.id, planId), eq(plans.accountId, accountId)))
      .returning();
    return toPlanDto(row);
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      throw new AppError(409, "PLAN_NAME_TAKEN", `You already have a ${plan.kind} plan with that name.`);
    }
    throw err;
  }
}
