import type { Db } from "./client.js";
import { plans } from "./schema.js";

export const PLAN_IDS = {
  starter: "00000000-0000-4000-8000-000000000001",
  pro: "00000000-0000-4000-8000-000000000002",
  basic: "00000000-0000-4000-8000-000000000003",
  premium: "00000000-0000-4000-8000-000000000004",
} as const;

const PREDEFINED_PLANS = [
  { id: PLAN_IDS.starter, kind: "account", name: "Starter", monthlyAllowance: 5_000, maxPerRequest: 100 },
  { id: PLAN_IDS.pro, kind: "account", name: "Pro", monthlyAllowance: 100_000, maxPerRequest: 1_000 },
  { id: PLAN_IDS.basic, kind: "user", name: "Basic", monthlyAllowance: 500, maxPerRequest: 20 },
  { id: PLAN_IDS.premium, kind: "user", name: "Premium", monthlyAllowance: 5_000, maxPerRequest: 100 },
];

export async function seedPredefinedPlans(db: Db): Promise<void> {
  await db
    .insert(plans)
    .values(PREDEFINED_PLANS.map((p) => ({ ...p, accountId: null, isPredefined: true })))
    .onConflictDoNothing();
}
