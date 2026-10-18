#!/usr/bin/env bash
# Usage: scripts/loadtest.sh <no-contention|contention> [VAR=value ...]
# Example: scripts/loadtest.sh contention VUS=100 DURATION=30s
# Requires the compose stack (postgres + service) to be running.
cd "$(dirname "$0")/.." || exit 1

SCENARIO=${1:?usage: scripts/loadtest.sh <no-contention|contention> [VAR=value ...]}
shift
LABEL=${LABEL:-$SCENARIO}
K6_IMAGE=${K6_IMAGE:-grafana/k6:latest}
NETWORK=${NETWORK:-metering-stack_default}

mkdir -p perf/results && chmod 777 perf/results

ENVS=()
for kv in "$@"; do ENVS+=(-e "$kv"); done

OUT="perf/results/$LABEL.txt"
: > "$OUT"

docker run --rm --network "$NETWORK" \
  -v "$PWD/perf/k6:/scripts:ro" -v "$PWD/perf/results:/results" \
  -e BASE_URL=http://service:3000 "${ENVS[@]}" \
  "$K6_IMAGE" run "/scripts/$SCENARIO.js" --summary-export="/results/$LABEL.json" 2>&1 | tee -a "$OUT"
K6_STATUS=${PIPESTATUS[0]}

echo "--- invariants check (account = sum of users = sum of accepted units) ---" | tee -a "$OUT"
docker compose exec -T service npm run db:check --silent 2>&1 | tee -a "$OUT"
CHECK_STATUS=${PIPESTATUS[0]}

echo "k6 exit code: $K6_STATUS | db:check exit code: $CHECK_STATUS" | tee -a "$OUT"
[ "$K6_STATUS" -eq 0 ] && [ "$CHECK_STATUS" -eq 0 ]
