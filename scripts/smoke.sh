#!/usr/bin/env bash
# End-to-end smoke test against a RUNNING service. Usage: scripts/smoke.sh [base-url]
B=${1:-http://localhost:3000}
H='Content-Type: application/json'
fail=0
check() { # name, expected substring, actual
  if [[ "$3" == *"$2"* ]]; then echo "PASS  $1"; else echo "FAIL  $1 (expected: $2) got: $3"; fail=1; fi
}
post() { curl -s -X POST "$B$1" -H "X-API-Key: $KEY" -H "$H" -d "$2"; }

check "health" '"status":"ok"' "$(curl -s $B/health)"
check "401 missing key" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/v1/account)"
check "401 wrong key" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/v1/account -H 'X-API-Key: mk_wrong')"

RES=$(curl -s -X POST $B/v1/accounts -H "$H" -d '{"name":"SmokeCorp"}')
KEY=$(echo "$RES" | sed -n 's/.*"apiKey":"\([^"]*\)".*/\1/p')
check "api key length 46" 46 "${#KEY}"

post /v1/users '{"userId":"alice"}' > /dev/null
post /v1/users '{"userId":"bob","planId":"00000000-0000-4000-8000-000000000004"}' > /dev/null

check "accepted"            '"accepted":true,'  "$(post /v1/consume '{"userId":"alice","units":10,"requestId":"s-1"}')"
check "user per-request"    'PER_REQUEST_LIMIT_EXCEEDED' "$(post /v1/consume '{"userId":"alice","units":25,"requestId":"s-2"}')"
check "retry replayed"      '"replayed":true'   "$(post /v1/consume '{"userId":"alice","units":10,"requestId":"s-1"}')"
check "409 payload reuse"   IDEMPOTENCY_KEY_REUSED "$(post /v1/consume '{"userId":"alice","units":11,"requestId":"s-1"}')"
check "400 fractional"      VALIDATION_ERROR    "$(post /v1/consume '{"userId":"alice","units":1.5,"requestId":"s-3"}')"
check "404 unknown user"    USER_NOT_FOUND      "$(post /v1/consume '{"userId":"ghost","units":1,"requestId":"s-4"}')"

PID=$(post /v1/plans '{"kind":"user","name":"Tiny","monthlyAllowance":15,"maxPerRequest":5}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -s -X PUT $B/v1/users/alice/plan -H "X-API-Key: $KEY" -H "$H" -d "{\"planId\":\"$PID\"}" > /dev/null
check "new plan: 8 > max 5" PER_REQUEST_LIMIT_EXCEEDED "$(post /v1/consume '{"userId":"alice","units":8,"requestId":"s-5"}')"
check "new plan: 5 ok"      '"accepted":true,' "$(post /v1/consume '{"userId":"alice","units":5,"requestId":"s-6"}')"
check "allowance exhausted" MONTHLY_ALLOWANCE_EXCEEDED "$(post /v1/consume '{"userId":"alice","units":1,"requestId":"s-7"}')"

check "account usage 15"    '"consumed":15' "$(curl -s $B/v1/usage -H "X-API-Key: $KEY")"
check "alice remaining 0"   '"remaining":0' "$(curl -s $B/v1/users/alice/usage -H "X-API-Key: $KEY")"
check "usage history"       '"months":[' "$(curl -s $B/v1/usage/history -H "X-API-Key: $KEY")"
check "requests has cursor" '"nextCursor":"' "$(curl -s "$B/v1/requests?limit=2" -H "X-API-Key: $KEY")"
check "invalid cursor"      INVALID_CURSOR "$(curl -s "$B/v1/requests?cursor=garbage" -H "X-API-Key: $KEY")"

[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
