import { check } from "k6";
import { Counter } from "k6/metrics";
import { call, createAccount, createPlan, createUser, setAccountPlan } from "./common.js";

const ACCOUNTS = Number(__ENV.ACCOUNTS || 20);
const USERS_PER_ACCOUNT = Number(__ENV.USERS || 5);

const accepted = new Counter("decisions_accepted");
const rejected = new Counter("decisions_rejected");
const replayed = new Counter("decisions_replayed");

export const options = {
  scenarios: {
    independent_accounts: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 40),
      duration: __ENV.DURATION || "30s",
    },
  },
  setupTimeout: "120s",
  thresholds: {
    // Real failures only: a business rejection is HTTP 200 and is NOT counted here.
    "http_req_failed{name:consume}": ["rate<0.01"],
    "http_req_duration{name:consume}": ["p(95)<2000"],
    checks: ["rate==1"],
  },
};

export function setup() {
  const runId = Date.now().toString(36);
  const accounts = [];
  for (let a = 0; a < ACCOUNTS; a++) {
    const acc = createAccount(`load-${runId}-${a}`);
    setAccountPlan(
      acc.key,
      createPlan(acc.key, { kind: "account", name: "Load-Acct", monthlyAllowance: 1000000000, maxPerRequest: 100 }),
    );
    const userPlan = createPlan(acc.key, {
      kind: "user",
      name: "Load-User",
      monthlyAllowance: 1000000000,
      maxPerRequest: 5,
    });
    const users = [];
    for (let u = 0; u < USERS_PER_ACCOUNT; u++) {
      createUser(acc.key, `u${u}`, userPlan);
      users.push(`u${u}`);
    }
    accounts.push({ key: acc.key, users });
  }
  return { runId, accounts };
}

export default function (data) {
  const acc = data.accounts[(__VU - 1) % data.accounts.length];
  const body = {
    userId: acc.users[Math.floor(Math.random() * acc.users.length)],
    units: 1 + Math.floor(Math.random() * 6), // 1..6; a per-request limit of 5 rejects about 1 in 6
    requestId: `${data.runId}-${__VU}-${__ITER}`,
  };

  const res = call("POST", "/v1/consume", acc.key, body, "consume");
  if (!check(res, { "consume status is 200": (r) => r.status === 200 })) return;
  const d = res.json();
  check(d, {
    "first send is a real decision (not a replay)": (x) => typeof x.accepted === "boolean" && x.replayed === false,
  });
  if (d.accepted) accepted.add(1);
  else rejected.add(1);

  // 10% of the time the client retries the same request (e.g. after a network timeout).
  if (Math.random() < 0.1) {
    const retry = call("POST", "/v1/consume", acc.key, body, "consume");
    if (check(retry, { "retry status is 200": (r) => r.status === 200 })) {
      const d2 = retry.json();
      replayed.add(1);
      check(d2, {
        "retry returns the original decision with replayed:true": (x) => x.replayed === true && x.accepted === d.accepted,
      });
    }
  }
}
