CREATE TABLE "account_usage" (
	"account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"consumed" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "account_usage_account_id_period_start_pk" PRIMARY KEY("account_id","period_start"),
	CONSTRAINT "account_usage_consumed_chk" CHECK ("account_usage"."consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"monthly_allowance" bigint NOT NULL,
	"max_per_request" integer NOT NULL,
	"is_predefined" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_kind_chk" CHECK ("plans"."kind" IN ('account', 'user')),
	CONSTRAINT "plans_allowance_chk" CHECK ("plans"."monthly_allowance" >= 0),
	CONSTRAINT "plans_max_per_request_chk" CHECK ("plans"."max_per_request" > 0),
	CONSTRAINT "plans_predefined_owner_chk" CHECK ("plans"."is_predefined" = ("plans"."account_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "usage_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"user_id" text NOT NULL,
	"units" integer NOT NULL,
	"accepted" boolean NOT NULL,
	"reason" text,
	"scope" text,
	"period_start" date NOT NULL,
	"applied_limits" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_requests_units_chk" CHECK ("usage_requests"."units" > 0),
	CONSTRAINT "usage_requests_request_id_len_chk" CHECK (length("usage_requests"."request_id") BETWEEN 1 AND 128),
	CONSTRAINT "usage_requests_scope_chk" CHECK ("usage_requests"."scope" IS NULL OR "usage_requests"."scope" IN ('account', 'user'))
);
--> statement-breakpoint
CREATE TABLE "user_usage" (
	"account_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"period_start" date NOT NULL,
	"consumed" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "user_usage_account_id_user_id_period_start_pk" PRIMARY KEY("account_id","user_id","period_start"),
	CONSTRAINT "user_usage_consumed_chk" CHECK ("user_usage"."consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"account_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_account_id_user_id_pk" PRIMARY KEY("account_id","user_id"),
	CONSTRAINT "users_user_id_len_chk" CHECK (length("users"."user_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_requests" ADD CONSTRAINT "usage_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_requests" ADD CONSTRAINT "usage_requests_account_id_user_id_users_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_account_id_user_id_users_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_predefined_name_uq" ON "plans" USING btree ("kind","name") WHERE "plans"."account_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_account_name_uq" ON "plans" USING btree ("account_id","kind","name") WHERE "plans"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_requests_account_request_uq" ON "usage_requests" USING btree ("account_id","request_id");--> statement-breakpoint
CREATE INDEX "usage_requests_account_created_idx" ON "usage_requests" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_requests_user_created_idx" ON "usage_requests" USING btree ("account_id","user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_plan_idx" ON "users" USING btree ("plan_id");