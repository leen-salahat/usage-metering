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
