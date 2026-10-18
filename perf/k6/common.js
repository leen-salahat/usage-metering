import http from "k6/http";

export const BASE = __ENV.BASE_URL || "http://localhost:3000";

/** One HTTP call. `name` groups metrics (e.g. name:consume) so setup traffic does not pollute results. */
export function call(method, path, key, body, name) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  return http.request(method, BASE + path, body === undefined ? null : JSON.stringify(body), {
    headers,
    tags: { name: name || `${method} ${path}` },
  });
}

function must(res, expected, what) {
  if (res.status !== expected) {
    throw new Error(`${what} failed: HTTP ${res.status} ${res.body}`);
  }
  return res.json();
}

export function createAccount(name) {
  const r = must(call("POST", "/v1/accounts", null, { name }, "setup"), 201, "create account");
  return { id: r.account.id, key: r.apiKey };
}

export function createPlan(key, plan) {
  return must(call("POST", "/v1/plans", key, plan, "setup"), 201, "create plan").id;
}

export function setAccountPlan(key, planId) {
  must(call("PUT", "/v1/account/plan", key, { planId }, "setup"), 200, "set account plan");
}

export function createUser(key, userId, planId) {
  must(call("POST", "/v1/users", key, { userId, planId }, "setup"), 201, "create user");
}
