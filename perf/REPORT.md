# Performance report

## Goal

Show how the service behaves under load, where time is spent, and, above all, that
**speed never costs correctness**. Every run ends with an automatic accounting check
(`npm run db:check`): for every account and UTC month,
`account counter = sum of user counters = sum of accepted request units`.

## Environment

See `perf/results/environment.txt`. Summary: 8 CPUs, 8 GB RAM, Docker 29.8.2 on WSL2,
PostgreSQL 16.15, Node 22.23.3, k6 v2.3.0.
**k6, the service and PostgreSQL all ran on the same machine**, so they compete for the
same CPU and disk. Absolute numbers are therefore indicative only.

## Method

- Tool: [k6](https://k6.io) (runs in Docker, no local install). It gives percentiles,
  thresholds and a JSON summary, and scripts are plain JavaScript that can be committed.
- Load model: `constant-vus`. Every virtual user sends a request, waits for the reply and
  immediately sends the next one (closed loop). The latency therefore includes queueing.
- Every run starts from an empty database (`docker compose down -v`, then `up`).
- Setup traffic (creating accounts, plans, users) is tagged `name:setup` and excluded from
  the reported latency, which uses the tag `name:consume`.
- A business rejection is HTTP 200 with `accepted:false`. It is counted separately
  (`decisions_rejected`) and is **not** an error. Real failures are measured by
  `http_req_failed{name:consume}`.

### Scenario 1: no contention (`perf/k6/no-contention.js`)

20 independent accounts, 5 users each, 40 virtual users, 30 s. Per-request limit of 5 units
while requests ask for 1 to 6, so about one request in six is rejected. In 10% of the
iterations the client retries the same request id, and the script checks that the retry
returns `replayed:true` with the original decision.

### Scenario 2: contention (`perf/k6/contention.js`)

**One** account with a monthly allowance of 1000 units, 20 users with huge allowances,
50 virtual users, 20 s, 1 unit per request. Far more than 1000 requests arrive, so every
request competes for the same account counter row. Checks: exactly 1000 requests accepted,
every rejection is `MONTHLY_ALLOWANCE_EXCEEDED` on scope `account`, and the final
`consumed` equals the allowance (never more).

## Results

All numbers are copied from `perf/results/*.txt`. Latency is `http_req_duration{name:consume}`.
`http_reqs` includes the small number of setup requests, so throughput is approximate.

### No contention

| Run | pool | http_reqs | req/s | avg | median | p95 | max | http errors |
|---|---|---|---|---|---|---|---|---|
| no-contention-pool10 | 10 | 15,686 | 501 | 77 ms | 73 ms | 107.5 ms | 206 ms | 0.00% |
| no-contention-pool10-run2 | 10 | 8,754 | 279 | 140 ms | 131 ms | 208 ms | 652 ms | 0 |
| no-contention-pool30 | 30 | 8,987 | 282 | 136 ms | 117 ms | 232 ms | 1.37 s | 0 |
| no-contention-pool30-run2 | 30 | 9,751 | 312 | 125 ms | 118 ms | 191 ms | 600 ms | 0 |

First run (pool 10): 11,683 accepted, 2,372 rejected (about 17% of the 14,055 first-time
decisions), 1,451 replays; 100% of 31,012 checks passed; invariants held on 20 accounts.

### Contention

| Run | pool | http_reqs | req/s | avg | median | p95 | max | accepted | http errors |
|---|---|---|---|---|---|---|---|---|---|
| contention-pool10 | 10 | 3,692 | 181 | 274 ms | 258 ms | 396 ms | 585 ms | 1000 | 0.00% |
| contention-observed | 10 | 3,638 | 178 | 278 ms | 242 ms | 396 ms | 1.84 s | 1000 | 0.00% |
| contention-pool30 | 30 | 3,295 | 161 | 307 ms | 287 ms | 608 ms | 829 ms | 1000 | 0 |

In every run `FINAL account usage: consumed=1000 allowance=1000 remaining=0` and the
invariants check passed.

## What the results show

1. **Correctness under the worst case.** With 50 concurrent clients hammering one account
   counter, about 3,300 to 3,700 requests were processed and **exactly 1000 were
   accepted**, in every run. No overspending, no deadlock, no HTTP error, and the
   invariants held afterwards. This is the property the row locks
   (`SELECT ... FOR UPDATE`, always account first, then user) exist to guarantee.
   A separate test (`tests/integration/concurrency.test.ts`) showed that removing the
   lock makes the same kind of test fail (25 accepted instead of 20).
2. **Contention costs throughput.** With independent accounts the service handled roughly
   280 to 500 requests per second; with one hot account roughly 160 to 180. This is consistent
   with requests for the same account being serialized on one row lock. The two scenarios
   differ in more than contention (number of accounts, virtual users, retries), so this is a
   direction, not a controlled comparison.
3. **Retries are safe under load.** All 1,451 retried requests in the first run returned
   `replayed:true` with the original decision and nothing was charged twice.

## Run-to-run variance and the connection pool experiment

The pool size (`DB_POOL_MAX`) limits how many transactions run at once (default 10).
We tested 30 expecting a gain without contention.

**We could not show any difference between pool 10 and pool 30.** The same configuration
(pool 10, no contention) produced 501 req/s in one run and 279 req/s in another, a
difference larger than the one between pool 10 and pool 30. Max latency also varied
between runs (for example 206 ms to 652 ms with pool 10). With contention, pool 30 was
somewhat slower in its single run (161 req/s, p95 608 ms versus about 180 req/s and
396 ms), which fits the idea that more connections do not help when requests queue on
one lock, but one run is not enough to claim it.

Correctness was identical in every configuration. We did not change the default pool size.

## Bottleneck: what we did and did not measure

- `docker stats` snapshots during the contention run showed the service at roughly
  66 to 71% CPU and PostgreSQL at roughly 48 to 61% CPU on a machine with 8 CPUs (800%).
  Neither process saturated the machine.
- We tried to look at lock waits with `pg_stat_activity` during the run. The snapshot was
  taken when the load was not running (only one idle/active connection), so it showed
  nothing. **We did not directly measure waiting on the row lock.** The statement that
  contention is caused by the account row lock is an interpretation, not a measurement.

## Limitations

- Everything ran on one machine under WSL2; k6 competes with the service and the database.
- Few repetitions per configuration, and high variance between runs. No statistical analysis.
- Closed-loop load: latency includes queueing, and throughput depends on the number of
  virtual users.
- The two scenarios are not identical apart from contention (see above).
- Only the consume endpoint was load tested; reads (usage, history) were not.
- Unexplained outliers: for example max 1.84 s in `contention-observed` versus 585 ms in
  the identical `contention-pool10`. We did not investigate the cause.

## Lessons

- Correctness must be verified next to performance: each run is followed by `db:check`,
  and the contention scenario asserts that the allowance is used exactly.
- One concurrency test with two requests passed even without the lock; the 50-request
  burst is what exposed the missing lock. Concurrency tests need real pressure.
- A single run per configuration is not evidence. Our first pool 30 result looked 44%
  slower than pool 10, and the repeat showed that was noise.
- A larger pool is not automatically an improvement. It must be measured.

## Reproduce

```bash
docker compose up -d --build --wait postgres service
LABEL=my-no-contention scripts/loadtest.sh no-contention
docker compose down -v
docker compose up -d --build --wait postgres service
LABEL=my-contention scripts/loadtest.sh contention
docker compose down -v
# different pool size:
DB_POOL_MAX=30 docker compose up -d --build --wait postgres service
```

Each run writes `perf/results/<LABEL>.txt` and `.json` and ends with the invariants check.
Extra settings can be passed as `VAR=value`, e.g.
`scripts/loadtest.sh contention VUS=100 DURATION=30s ALLOWANCE=500`.
Requires Docker; the k6 image (`grafana/k6`) is pulled automatically.
