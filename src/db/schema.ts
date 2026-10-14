import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * PLANS: the *definition* of limits.
 * account_id NULL  => predefined plan (read-only, global)
 * account_id set   => custom plan owned by that account
 */
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references((): AnyPgColumn => accounts.id),
    kind: text("kind").notNull(), // 'account' | 'user'
    name: text("name").notNull(),
    monthlyAllowance: bigint("monthly_allowance", { mode: "number" }).notNull(),
    maxPerRequest: integer("max_per_request").notNull(),
    isPredefined: boolean("is_predefined").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("plans_kind_chk", sql`${t.kind} IN ('account', 'user')`),
    check("plans_allowance_chk", sql`${t.monthlyAllowance} >= 0`),
    check("plans_max_per_request_chk", sql`${t.maxPerRequest} > 0`),
    check("plans_predefined_owner_chk", sql`${t.isPredefined} = (${t.accountId} IS NULL)`),
    uniqueIndex("plans_predefined_name_uq")
      .on(t.kind, t.name)
      .where(sql`${t.accountId} IS NULL`),
    uniqueIndex("plans_account_name_uq")
      .on(t.accountId, t.kind, t.name)
      .where(sql`${t.accountId} IS NOT NULL`),
  ],
);

/** ACCOUNTS: a calling application/company. Holds the current account plan assignment. */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  apiKeyPrefix: text("api_key_prefix").notNull(),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** USERS: end users of an account. Holds the current user plan assignment. */
export const users = pgTable(
  "users",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    userId: text("user_id").notNull(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId] }),
    check("users_user_id_len_chk", sql`length(${t.userId}) BETWEEN 1 AND 128`),
    index("users_plan_idx").on(t.planId),
  ],
);

/** ACCOUNT_USAGE: one counter row per account per UTC month. */
export const accountUsage = pgTable(
  "account_usage",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    consumed: bigint("consumed", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.periodStart] }),
    check("account_usage_consumed_chk", sql`${t.consumed} >= 0`),
  ],
);

/** USER_USAGE: one counter row per user per UTC month. */
export const userUsage = pgTable(
  "user_usage",
  {
    accountId: uuid("account_id").notNull(),
    userId: text("user_id").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    consumed: bigint("consumed", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId, t.periodStart] }),
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [users.accountId, users.userId],
    }),
    check("user_usage_consumed_chk", sql`${t.consumed} >= 0`),
  ],
);

/**
 * USAGE_REQUESTS: immutable log of every consumption decision.
 * UNIQUE(account_id, request_id) is the idempotency guarantee.
 */
export const usageRequests = pgTable(
  "usage_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    requestId: text("request_id").notNull(),
    userId: text("user_id").notNull(),
    units: integer("units").notNull(),
    accepted: boolean("accepted").notNull(),
    reason: text("reason"),
    scope: text("scope"), // 'account' | 'user' (set when rejected)
    periodStart: date("period_start", { mode: "string" }).notNull(),
    appliedLimits: jsonb("applied_limits"), // snapshot of limits used for this decision
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [users.accountId, users.userId],
    }),
    uniqueIndex("usage_requests_account_request_uq").on(t.accountId, t.requestId),
    check("usage_requests_units_chk", sql`${t.units} > 0`),
    check("usage_requests_request_id_len_chk", sql`length(${t.requestId}) BETWEEN 1 AND 128`),
    check("usage_requests_scope_chk", sql`${t.scope} IS NULL OR ${t.scope} IN ('account', 'user')`),
    index("usage_requests_account_created_idx").on(t.accountId, t.createdAt.desc(), t.id.desc()),
    index("usage_requests_user_created_idx").on(
      t.accountId,
      t.userId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);
