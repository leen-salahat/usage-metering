# Usage Metering and Quota Service

A backend service that other applications call to **track resource usage and decide
whether a user may perform an action**. Limits are enforced at two independent levels:

- the calling application or company (**account**), whose allowance is shared by all its users;
- each **user** of that account.

TypeScript, Express, PostgreSQL (Drizzle ORM for schema and migrations, hand-written SQL for the
critical transaction), Docker Compose. One service, one database, plus an example client.

## Contents

1. [Quick start](#quick-start)
2. [Concepts](#concepts)
3. [Predefined plans](#predefined-plans)
4. [How a consumption request is decided](#how-a-consumption-request-is-decided)
5. [API](#api)
6. [Idempotency and retries](#idempotency-and-retries)
7. [Concurrency and atomic accounting](#concurrency-and-atomic-accounting)
8. [Monthly accounting and plan changes](#monthly-accounting-and-plan-changes)
9. [Architecture and database schema](#architecture-and-database-schema)
10. [Product assumptions](#product-assumptions)
11. [The example client](#the-example-client)
12. [Tests](#tests)
13. [Performance](#performance)
14. [Local development](#local-development)
15. [Known limitations](#known-limitations)

## Quick start

Requires Docker with Compose.

```bash
git clone <repository-url> usage-metering
cd usage-metering
docker compose up --build
```

This starts PostgreSQL, the service (which waits for the database, applies migrations and
seeds the predefined plans) and the **example client**, which runs a fixed scenario against
the real HTTP API and prints every decision. The client exits with code 0 when every decision
matched the expected business rule. PostgreSQL and the service keep running.

- Service: <http://localhost:3000> (`GET /health`, `GET /ready`)
- Run the demo again: `docker compose run --rm client`
- Stop: `Ctrl+C`, then `docker compose down` (add `-v` to also delete the data volume)

Configuration is optional (see `.env.example`): `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `SERVICE_PORT`, `DB_POOL_MAX`. The defaults are for local demos only.
PostgreSQL is not published to the host. To inspect it:
`docker compose exec postgres psql -U metering -d metering`.

## Concepts

| Concept | Meaning |
|---|---|
| **Account** | A calling application. Has an API key, an account plan, its own users and custom plans. |
| **User** | An end user of an account, identified by an id chosen by the calling application. |
| **Plan** | A named set of limits: `monthlyAllowance` and `maxPerRequest`. Kind `account` or `user`. |
| **Units** | The single resource that is consumed (for example document-processing credits). |

Important distinctions:

- **A plan is a definition, not usage.** Many users can share one plan; each keeps its own
  usage. Accounts and users *reference* their plan, so updating a custom plan changes the limits
  seen by everyone assigned to it, with a single `UPDATE`.
- **The two levels are independent.** A request must satisfy both the account plan and the user
  plan. Allowances are never added together. Giving one user a bigger plan does not increase the
  account's shared allowance.

## Predefined plans

Seeded at startup (idempotently), read-only.

| Plan | Kind | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 5,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 500 | 20 |
| Premium | user | 5,000 | 100 |

New accounts get Starter and new users get Basic unless a plan is given.
Accounts can create, view, update and assign **custom plans** of their own.

## How a consumption request is decided

For `POST /v1/consume` with `{ userId, units, requestId }`:

1. The account is identified by the API key (never by the request body).
2. The payload is validated. `units` must be a positive whole number.
3. The user must belong to the account (otherwise 404).
4. The current account plan and user plan are read.
5. All four rules are evaluated; the **whole** amount is accepted only if all pass:
   user per-request limit, account per-request limit, user monthly remaining,
   account monthly remaining.
6. If accepted, both the user counter and the account counter increase by `units`.
   If rejected, **nothing** is consumed.
7. The outcome is stored (with a snapshot of the limits used) and returned.

Rejection reason when several rules fail (deterministic): user per-request, account per-request,
user monthly, account monthly. Reasons: `PER_REQUEST_LIMIT_EXCEEDED`,
`MONTHLY_ALLOWANCE_EXCEEDED`; `scope` is `user` or `account`.

Example from the brief: account plan 10,000/month and 100 per request, user plan 1,000/month and
20 per request.

- 25 units: rejected by the **user** per-request limit.
- 10 units: accepted; user usage +10 and account usage +10.
- Account has only 5 left: 10 units rejected by the **account** monthly allowance, even if the user
  has plenty left.

The rule logic is a pure function (`src/domain/quota.ts`) with its own unit tests.

## API

All paths are under `/v1`. JSON in and out. Except `POST /v1/accounts`, every request needs the
header `X-API-Key: <key>`.

### Getting and using an API key

```bash
curl -s -X POST localhost:3000/v1/accounts -H 'Content-Type: application/json' -d '{"name":"DocuCorp"}'
# {"account":{...},"apiKey":"mk_...","apiKeyPrefix":"mk_xxxxx"}
KEY=mk_...   # paste the apiKey
curl -s localhost:3000/v1/account -H "X-API-Key: $KEY"
```

The raw key is returned **once**, at creation. Only a SHA-256 hash (and an 8-character prefix for
debugging) is stored. Keys are 256 bits of cryptographic randomness, which is why a fast hash is
appropriate (unlike human passwords). There is no key rotation in this version.

### Endpoints

| Method and path | Purpose |
|---|---|
| `POST /v1/accounts` | Create account and API key. Public. Optional `planId` (account plan), default Starter. |
| `GET /v1/account` | The account and its current plan. |
| `PUT /v1/account/plan` | `{ "planId" }` switch the account plan. |
| `POST /v1/users` | `{ "userId", "planId"? }` register a user (default plan Basic). |
| `GET /v1/users`, `GET /v1/users/:userId` | List (`?limit`) and read users. |
| `PUT /v1/users/:userId/plan` | `{ "planId" }` change a user's plan. |
| `GET /v1/plans` | Predefined plans plus your own (`?kind=account|user`). |
| `POST /v1/plans` | `{ "kind", "name", "monthlyAllowance", "maxPerRequest" }` create a custom plan. |
| `GET /v1/plans/:id`, `PATCH /v1/plans/:id` | Read; update a custom plan (predefined: 403). |
| `POST /v1/consume` | `{ "userId", "units", "requestId" }` the central operation. |
| `GET /v1/usage` | Current UTC month usage of the account. |
| `GET /v1/users/:userId/usage` | The user's usage plus the shared account numbers and `maxConsumableNow`. |
| `GET /v1/usage/history`, `GET /v1/users/:userId/usage/history` | Previous months (`?limit`, default 12, max 24). |
| `GET /v1/requests` | Request outcomes, newest first. `?limit` (1-500, default 50), `?cursor`, `?userId`, `?accepted=true|false`. |
| `GET /v1/requests/:requestId` | One stored outcome. |
| `GET /health`, `GET /ready` | Liveness; readiness (checks the database, 503 if unreachable). |

### Consume: request and response

```bash
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"userId":"alice","units":10,"requestId":"order-1001"}'
```

```json
{
  "requestId": "order-1001", "userId": "alice", "units": 10,
  "accepted": true, "reason": null, "scope": null,
  "period": "2026-10", "replayed": false,
  "account": { "planName": "Starter", "monthlyAllowance": 5000, "maxPerRequest": 100, "consumed": 10, "remaining": 4990 },
  "user":    { "planName": "Basic",   "monthlyAllowance": 500,  "maxPerRequest": 20,  "consumed": 10, "remaining": 490 }
}
```

A rejection looks the same with `"accepted": false`, a `reason` and a `scope`, and `consumed` unchanged.
`requestId`: 1-128 characters from `A-Z a-z 0-9 _ . @ : -`. `units`: integer from 1.

### Errors

Business rejections are **decisions** (HTTP 200, `accepted:false`), not errors. Real errors always
have this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [] } }
```

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_CURSOR`, `PLAN_KIND_MISMATCH` |
| 401 | `MISSING_API_KEY`, `INVALID_API_KEY` |
| 403 | `PLAN_READ_ONLY` |
| 404 | `USER_NOT_FOUND`, `PLAN_NOT_FOUND`, `REQUEST_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | `USER_ALREADY_EXISTS`, `PLAN_NAME_TAKEN`, `IDEMPOTENCY_KEY_REUSED` |
| 413 / 500 / 503 | `PAYLOAD_TOO_LARGE` / `INTERNAL_ERROR` (details only in server logs) / `/ready` unavailable |

### Account isolation

The account is always the one identified by the API key. Every query is scoped by `account_id`, and
users have a composite primary key `(account_id, user_id)` referenced by composite foreign keys.
Another account's users, plans, usage and requests answer **404** (not 403, which would reveal
that they exist). A body `accountId` is ignored. Tests cover this on every endpoint group.

## Idempotency and retries

Every consume request carries a `requestId`, unique **per account** (a database unique index on
`(account_id, request_id)`).

| Situation | Result |
|---|---|
| Retry, same `userId` and `units` | The stored decision is returned with `replayed: true`. Nothing is consumed again. |
| Original was accepted | Retry stays accepted, even if the plan has since changed. |
| Original was rejected | Retry stays rejected, even if the plan would now allow it. |
| Same `requestId`, different `userId` or `units` | `409 IDEMPOTENCY_KEY_REUSED`. Nothing changes. |
| Retry in a later month | Original decision and period returned; no usage is touched. |
| Identical retries arriving at the same time | The first reserves the id; the others wait for its commit, then read the stored result. Exactly one real execution. |
| A new `requestId` | Evaluated again against the current plan. |

Two accounts may use the same `requestId` independently. A request for an unknown user returns
404 before anything is recorded.

## Concurrency and atomic accounting

Each consume request is **one database transaction** (READ COMMITTED):

1. Check the user belongs to the account.
2. `INSERT ... ON CONFLICT (account_id, request_id) DO NOTHING` reserves the request id.
   Zero rows back means a retry: return the stored outcome (or 409).
3. Create this month's counter rows if missing (`ON CONFLICT DO NOTHING`).
4. Lock the counters with `SELECT ... FOR UPDATE` in a **fixed order: account row, then user row**.
   Concurrent requests for the same account queue here and read the fresh value after the
   previous one commits. The fixed order prevents deadlocks.
5. Read both current plans with `FOR SHARE`.
6. Decide with the pure function.
7. If accepted, update both counters.
8. Update the request row with the outcome and a snapshot of the limits used.
9. `COMMIT`. Any failure rolls back everything (reservation, counters, record).

A read-check-write sequence without the lock would let two requests both see "10 left" and both
spend 7. Verified by tests: concurrent 7+7 against 10 left, 50 concurrent 1-unit requests against
an allowance of 20 (exactly 20 accepted), 10 identical concurrent retries (one execution), and a
failure injected after the account counter update (everything rolled back). Removing the lock
makes the 50-request test fail. See [Performance](#performance) for results under load.

**Plan updates racing with consumption:** consume reads plans with `FOR SHARE`; an update takes
an exclusive lock on the plan row. A plan update therefore takes effect for every consume that
reads the plan **after the update commits**; one that already holds the share lock finishes with
the old values first. Past decisions are never rewritten (their limits are stored in the snapshot).

The accounting invariant, per account and month, is checked by `npm run db:check`:
`account counter = sum of user counters = sum of accepted request units`.

## Monthly accounting and plan changes

- Months are **UTC calendar months**, computed from the server clock when the request is
  processed (`getUTC*`, not local time). Usage rows are created lazily; a new month starts at zero
  and earlier months are never modified, so history stays queryable.
- Switching plans or editing a plan **preserves consumed units**; it never grants a fresh allowance.
- If the allowance is lowered below existing usage, `remaining` is reported as **0** (never
  negative) and further consumption at that level is rejected until the allowance allows it again.
- The clock is injectable, so month boundaries are tested deterministically.

## Architecture and database schema
example client --HTTP, X-API-Key--> service (Express) --SQL--> PostgreSQL
routes -> services -> database


| Layer | Role |
|---|---|
| `src/http/` | Routes, validation (Zod), auth middleware, error format. No business rules. |
| `src/services/` | Business logic and transactions (`consumption.ts` is the core). |
| `src/domain/` | Pure functions: quota rules, UTC period, API key helpers. |
| `src/db/` | Drizzle schema, migrations, seed, startup wait, invariants check. |

Tables: `plans`, `accounts`, `users`, `account_usage`, `user_usage`, `usage_requests`.

- `plans(account_id NULL = predefined)`; partial unique indexes keep names unique per kind
  (`NULL` is not equal to `NULL` in a normal unique index).
- `accounts` and `users` hold a `plan_id` reference (the *current assignment*).
- Usage is stored as **mutable counters** per month (`account_usage`, `user_usage`) plus an
  **immutable request log** (`usage_requests`). Counters are fast to read; the log provides
  history and idempotency. No event sourcing.
- CHECK constraints (`units > 0`, `consumed >= 0`, valid kinds, positive limits), composite foreign
  keys, and `UNIQUE(account_id, request_id)` make the database the last line of defence.
- Indexes on `usage_requests (account_id, created_at DESC, id DESC)` (and per user) serve the
  newest-first keyset pagination (no OFFSET).

Migrations are SQL files in `drizzle/`, applied at every startup (see limitations).

## Product assumptions

The full table with reasoning is in [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) (44 entries). The most
important: unauthenticated account creation (bootstrap); API key stored hashed and shown once;
user ids chosen by the caller; predefined plans read-only and plans cannot be deleted; plan kind
(account/user) enforced in the service layer; rejection is HTTP 200; request ids scoped per
account; unknown/foreign resources answer 404.

## The example client

`client/` is a small CLI (TypeScript) that calls the real API with an account's API key. It runs
a deterministic scenario (10 steps) and **fails with exit code 1 if any decision differs from the
expected one**:

- account plan `Team-100`: 100/month, 50 per request; alice `Basic-Demo` 40/month, 10 per request;
  bob `Premium-Demo` 80/month, 30 per request;
- accepted request; rejection by alice's **user** limit; rejection of bob by the **shared account**
  limit although he has 20 left himself; a safe retry (replay);
- the account allowance is raised to 200 and the same request that failed is accepted; alice is
  moved to another plan and a request that failed before is accepted, with her earlier usage kept;
- final check: account total (125) = alice (45) + bob (80).

The client code does not change when plans change: it only calls the API. Run it with
`docker compose up --build` or `docker compose run --rm client`.

## Tests

```bash
docker compose -f docker-compose.dev.yml up -d   # test PostgreSQL on localhost:5433
cp .env.example .env
npm install
npm test            # 101 tests
npm run typecheck   # service and client
```

Needs a database named `metering_test` (`docker compose -f docker-compose.dev.yml exec postgres
psql -U metering -d metering -c "CREATE DATABASE metering_test;"`). Test helpers refuse to run
against a database whose name does not contain `test`.

Unit tests: quota rules (boundaries), UTC periods, API key helpers, database wait/retry.
Integration tests (real PostgreSQL, real HTTP): schema constraints, accounts and auth (401),
users, plans, consume rules and boundaries, validation, account isolation, idempotency cases,
concurrency and atomicity, usage reporting, request history and pagination, invariants checker,
health/readiness. An end-to-end script against a running service: `scripts/smoke.sh`.

## Performance

Load tests use k6 with two scenarios (many independent accounts; one hot account), each followed
by the accounting invariants check. Full method, numbers, variance and limitations are in
[`perf/REPORT.md`](perf/REPORT.md); raw outputs are in `perf/results/`.

Headline results (single machine, indicative): with one account receiving 50 concurrent clients
and an allowance of 1000, about 3,300 to 3,700 requests were processed and **exactly 1000 were
accepted in every run**, with no HTTP errors and the invariants intact. Throughput was roughly
160 to 180 requests/s with that contention and roughly 280 to 500 requests/s with independent
accounts (high run-to-run variance). A larger connection pool (30 vs 10) showed no demonstrable
gain without contention.

```bash
docker compose up -d --build --wait postgres service
LABEL=my-run scripts/loadtest.sh no-contention      # or: contention
```

## Local development

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d      # PostgreSQL on host port 5433
npm install
npm run db:migrate && npm run db:seed
npm run dev                                         # http://localhost:3000
npm run db:check                                    # accounting invariants
```

Dev PostgreSQL uses port 5433 so it does not clash with a local PostgreSQL on 5432.

## Known limitations

- Migrations run at every service start: fine for one instance; several instances would need a
  separate migration job.
- Throughput for a single account is bounded by serialization on its counter row (the price of
  never overspending). Different accounts proceed in parallel.
- No API key rotation or revocation, and no deletion of plans, users or accounts.
- No retention policy for request history.
- The account/user plan-kind rule is enforced in the service layer, not by the database schema.
- Pagination uses `created_at` (transaction start time); a transaction that waited for a lock can
  commit a row "in the past" after a client already paged beyond it.
- The container runs TypeScript through `tsx` (no compile step): simple, but a larger image.
- Performance numbers come from one machine with high variance; lock waiting was not measured
  directly.
- The default database credentials in `docker-compose.yml` are for local demos only.
