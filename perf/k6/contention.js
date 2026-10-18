import { check } from "k6";
import { Counter } from "k6/metrics";
import { call, createAccount, createPlan, createUser, setAccountPlan } from "./common.js";

const ALLOWANCE = Number(__ENV.ALLOWANCE || 1000);
const USERS = Number(__ENV.USERS || 20);

const accepted = new Counter("decisions_accepted");
const rejected = new Counter("decisions_rejected");

export const options = {
  scenarios: {
    one_hot_account: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || "20s",
    },
  },
  setupTimeout: "120s",
  thresholds: {
    "http_req_failed{name:consume}": ["rate<0.01"],
    "http_req_duration{name:consume}": ["p(95)<5000"],
    checks: ["rate==1"],
  },
};

export function setup() {
  const runId = Date.now().toString(36);
  const acc = createAccount(`hot-${runId}`);
  setAccountPlan(
    acc.key,
    createPlan(acc.key, { kind: "account", name: "Hot-Acct", monthlyAllowance: ALLOWANCE, maxPerRequest: 10 }),
  );
  const userPlan = createPlan(acc.key, { kind: "user", name: "Hot-User", monthlyAllowance: 1000000000, maxPerRequest: 10 });
  const users = [];
  for (let u = 0; u < USERS; u++) {
    createUser(acc.key, `u${u}`, userPlan);
    users.push(`u${u}`);
  }
  return { runId, key: acc.key, users, allowance: ALLOWANCE };
}

export default function (data) {
  const res = call(
    "POST",
    "/v1/consume",
    data.key,
    {
      userId: data.users[Math.floor(Math.random() * data.users.length)],
      units: 1,
      requestId: `${data.runId}-${__VU}-${__ITER}`,
    },
    "consume",
  );
  if (!check(res, { "consume status is 200": (r) => r.status === 200 })) return;
  const d = res.json();
  if (d.accepted) {
    accepted.add(1);
  } else {
    rejected.add(1);
    // Only the shared account allowance can run out here (the users have huge allowances).
    check(d, {
      "every rejection is MONTHLY_ALLOWANCE_EXCEEDED on the account": (x) =>
        x.reason === "MONTHLY_ALLOWANCE_EXCEEDED" && x.scope === "account",
    });
  }
}

export function teardown(data) {
  const usage = call("GET", "/v1/usage", data.key, undefined, "usage").json();
  console.log(`FINAL account usage: consumed=${usage.consumed} allowance=${usage.monthlyAllowance} remaining=${usage.remaining}`);
  check(usage, {
    "NO OVERSPENDING: consumed never exceeds the allowance": (u) => u.consumed <= data.allowance,
    "the allowance was fully used (the load really exceeded it)": (u) => u.consumed === data.allowance,
  });
}
