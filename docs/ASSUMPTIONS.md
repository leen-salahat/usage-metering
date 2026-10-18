# Product Assumptions

This document records every product decision made where the project brief
was silent, together with the reasoning. It will be merged into the README.

## Predefined plans

| Plan    | Kind    | Monthly allowance | Max per request |
|---------|---------|-------------------|-----------------|
| Starter | account | 5,000             | 100             |
| Pro     | account | 100,000           | 1,000           |
| Basic   | user    | 500               | 20              |
| Premium | user    | 5,000             | 100             |

## Decisions

| #  | Topic              | Decision                                                                                          | Reasoning                                                            |
|----|--------------------|---------------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| 1  | Account creation   | `POST /v1/accounts` is unauthenticated (bootstrap). Returns the raw API key once.                 | An account cannot have a key before it exists.                       |
| 2  | API key storage    | Key = `mk_` + 32 random bytes (base64url). Only SHA-256 hash and a short prefix are stored.       | Keys are high-entropy, so a fast hash is safe. Plaintext never stored. |
| 3  | User identity      | The calling app supplies its own `userId` (string, 1-128 chars). Primary key = (account_id, user_id). | Isolation is enforced by the schema itself.                      |
| 4  | Plans              | A plan is a definition of limits. Accounts and users reference it via `plan_id`. Usage is stored separately. | Updating a custom plan affects all assignees automatically. |
| 5  | Predefined plans   | Read-only, `account_id IS NULL`. Seeded at startup, idempotently.                                 | Required by the brief.                                               |
| 6  | Custom plan names  | Unique per (account, kind). Predefined names are unique per kind.                                 | Avoids ambiguity in listings.                                        |
| 7  | Plan deletion      | Not supported.                                                                                    | Out of scope. Avoids dangling assignments.                           |
| 8  | Usage storage      | Mutable counters (`account_usage`, `user_usage`) plus an immutable `usage_requests` log.          | Counters are fast. The log gives history and idempotency.            |
| 9  | Months             | UTC calendar month. `period_start` is the first day of the month (`date`).                        | Deterministic boundaries.                                            |
| 10 | Business rejection | HTTP 200 with `accepted: false`, `reason`, `scope`.                                               | A rejection is a decision, not an error.                             |
| 11 | Errors             | 400 / 401 / 404 / 409 / 500 with `{ "error": { "code", "message" } }`.                            | One consistent format.                                               |
| 12 | Idempotency        | Scoped per account. Same id and same payload returns the stored decision. Same id with a different payload returns 409. | Safe retries and stable decisions. |
| 13 | `userId` format | 1-128 chars from `A-Z a-z 0-9 _ . @ : -`. | Keeps URLs and logs safe; covers emails and UUIDs. |
| 14 | Default plans | If `planId` is omitted: new accounts get Starter, new users get Basic. | An account/user must always have a valid plan. |
| 15 | Plan visibility | An account sees predefined plans plus its own custom plans. Other accounts' plans return 404. | 404 (not 403) does not reveal that the id exists elsewhere. |
| 16 | Predefined plans | Read-only: `PATCH` returns 403 `PLAN_READ_ONLY`. | Required by the brief. |
| 17 | Plan kind | An account plan cannot be assigned to a user and vice versa (400 `PLAN_KIND_MISMATCH`). | Enforced in the service layer; the DB schema alone cannot express it cheaply. |
| 18 | API key | One key per account, sent in `X-API-Key`. No rotation in this version. | Keeps scope small; rotation is a documented limitation. |
| 19 | Plan patches | `PATCH` is strict: unknown fields (e.g. `kind`) and empty bodies return 400. | Silent ignoring would hide client bugs. |
| 20 | Cross-account access | Users/plans of another account return 404, never 403. | No information leak about other accounts. |
| 30 | Usage endpoints | `GET /v1/usage` and `GET /v1/users/:userId/usage` report the current UTC month (server clock), the plan applied right now, `consumed`, and `remaining = max(0, allowance - consumed)`. | The brief asks for consumed and remaining at both levels. |
| 31 | Consistent reads | The user endpoint reads user and account numbers in ONE SQL statement; reads take no locks. | One statement sees one snapshot, so the two levels never disagree with each other. |
| 32 | `maxConsumableNow` | Informational: `min(user remaining, account remaining, user max per request, account max per request)`. It is not a reservation. | Lets a client know what would be accepted at this moment. |
| 33 | Monthly history | Lists months that have usage rows, newest first (default 12, max 24), reporting `consumed` only. Months with no requests do not appear. | Plan limits are not versioned per month. Limits at decision time are in each request's snapshot. |
| 34 | Request history | `GET /v1/requests`: newest first, keyset cursor on `(created_at, id)`, `limit` default 50 (max 500), filters `userId` and `accepted`. Includes rejected requests. | Keyset avoids OFFSET cost and is stable while new rows arrive. |
| 35 | Cursor | Opaque base64url token, validated; a malformed one returns 400 `INVALID_CURSOR`. | Callers must not depend on its content. |
| 36 | Pagination limitation | `created_at` is the transaction start time. A transaction that waited for a lock may commit a row "in the past" after a client already paged beyond it. | Rare, and acceptable for an audit-style history. Documented trade-off. |
| 37 | Request lookup | `GET /v1/requests/:requestId` returns the stored outcome and decision snapshot (404 if unknown, including another account's id). | Lets a caller check the outcome of a request after a timeout. |
| 38 | Health endpoints | `GET /health` is liveness (never touches the database). `GET /ready` checks the database and returns 503 when it is unreachable. | A database outage must not look like a dead process; Compose uses `/ready` for the service healthcheck. |
| 39 | Startup order | Wait for the database (30 attempts, 1s apart), apply migrations, seed predefined plans, then listen. A clear error and exit if the database never answers. | The brief requires initialization at startup; `depends_on` alone does not guarantee the database accepts connections. |
| 40 | Migrations at startup | The service applies migrations itself on every start. Suited to a single service instance. | Simplest reproducible setup; running several instances would need a separate migration job (known limitation). |
| 41 | Graceful shutdown | On SIGTERM/SIGINT the service stops accepting connections, lets in-flight requests (and their transactions) finish, closes the pool, and force-exits after 10s. | A consume transaction must not be cut in half by a deployment. |
| 42 | Compose stack | PostgreSQL is not published to the host. Credentials come from env with local-demo defaults. Data lives in the named volume `pgdata`; `docker compose down -v` wipes it. | Avoids port clashes and keeps secrets out of Git. |
| 43 | Example client | A CLI that runs a fixed scenario through the real HTTP API and exits non-zero if any decision differs from the expected one. Re-run with `docker compose run --rm client`. | Deterministic, self-verifying demonstration of account vs user limits and plan changes. |
| 44 | Container runtime | Images run TypeScript through `tsx` (no compile step) as a non-root user. | Fewer moving parts; trade-off is a larger image. |
| 38 | Health endpoints | `GET /health` is liveness (never touches the database). `GET /ready` checks the database and returns 503 when it is unreachable. | A database outage must not look like a dead process; Compose uses `/ready` for the service healthcheck. |
| 39 | Startup order | Wait for the database (30 attempts, 1s apart), apply migrations, seed predefined plans, then listen. A clear error and exit if the database never answers. | The brief requires initialization at startup; `depends_on` alone does not guarantee the database accepts connections. |
| 40 | Migrations at startup | The service applies migrations itself on every start. Suited to a single service instance. | Simplest reproducible setup; running several instances would need a separate migration job (known limitation). |
| 41 | Graceful shutdown | On SIGTERM/SIGINT the service stops accepting connections, lets in-flight requests (and their transactions) finish, closes the pool, and force-exits after 10s. | A consume transaction must not be cut in half by a deployment. |
| 42 | Compose stack | PostgreSQL is not published to the host. Credentials come from env with local-demo defaults. Data lives in the named volume `pgdata`; `docker compose down -v` wipes it. | Avoids port clashes and keeps secrets out of Git. |
| 43 | Example client | A CLI that runs a fixed scenario through the real HTTP API and exits non-zero if any decision differs from the expected one. Re-run with `docker compose run --rm client`. | Deterministic, self-verifying demonstration of account vs user limits and plan changes. |
| 44 | Container runtime | Images run TypeScript through `tsx` (no compile step) as a non-root user. | Fewer moving parts; trade-off is a larger image. |
