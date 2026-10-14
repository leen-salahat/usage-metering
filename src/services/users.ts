import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pgErrorCode } from "../db/errors.js";
import { PLAN_IDS } from "../db/seed.js";
import { plans, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { findAssignablePlan, toPlanDto } from "./plans.js";

type UserRow = typeof users.$inferSelect;
type PlanRow = typeof plans.$inferSelect;

export function toUserDto(u: UserRow, plan: PlanRow) {
  return { userId: u.userId, createdAt: u.createdAt.toISOString(), plan: toPlanDto(plan) };
}

/** Every lookup is scoped by (account_id, user_id): another account's user is simply "not found". */
export async function getUser(db: Db, accountId: string, userId: string) {
  const [row] = await db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(and(eq(users.accountId, accountId), eq(users.userId, userId)));
  if (!row) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
  return toUserDto(row.user, row.plan);
}

export async function listUsers(db: Db, accountId: string, limit: number) {
  const rows = await db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(eq(users.accountId, accountId))
    .orderBy(asc(users.createdAt), asc(users.userId))
    .limit(limit);
  return rows.map((r) => toUserDto(r.user, r.plan));
}

export async function createUser(
  db: Db,
  accountId: string,
  input: { userId: string; planId?: string },
) {
  const plan = await findAssignablePlan(db, accountId, input.planId ?? PLAN_IDS.basic, "user");
  try {
    await db.insert(users).values({ accountId, userId: input.userId, planId: plan.id });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      throw new AppError(409, "USER_ALREADY_EXISTS", `User "${input.userId}" already exists.`);
    }
    throw err;
  }
  return getUser(db, accountId, input.userId);
}

export async function setUserPlan(db: Db, accountId: string, userId: string, planId: string) {
  await getUser(db, accountId, userId); // 404 if the user is not in this account
  const plan = await findAssignablePlan(db, accountId, planId, "user");
  await db
    .update(users)
    .set({ planId: plan.id })
    .where(and(eq(users.accountId, accountId), eq(users.userId, userId)));
  return getUser(db, accountId, userId);
}
