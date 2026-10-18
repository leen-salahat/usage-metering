import { ApiError, MeteringClient, type LevelView } from "./api.js";

const BASE_URL = process.env.METERING_URL ?? "http://localhost:3000";
const client = new MeteringClient(BASE_URL);

let step = 0;
let mismatches = 0;

const title = (text: string) => console.log(`\n=== ${text} ===`);
const note = (text: string) => console.log(`    ${text}`);

const levelLine = (name: string, l: LevelView) =>
  `    ${name.padEnd(8)}: ${String(l.consumed).padStart(3)}/${l.monthlyAllowance} used, ` +
  `${String(l.remaining).padStart(3)} left, max ${l.maxPerRequest}/request  [${l.planName}]`;

interface Expected {
  accepted: boolean;
  reason?: string;
  scope?: "account" | "user";
  replayed?: boolean;
}

async function attempt(userId: string, units: number, requestId: string, expected: Expected, why: string) {
  step++;
  console.log(`\n[${step}] ${userId} asks for ${units} units  (requestId: ${requestId})`);
  const r = await client.consume(userId, units, requestId);
  const verdict = r.accepted ? "ACCEPTED" : `REJECTED  reason=${r.reason}  scope=${r.scope}`;
  console.log(`    -> ${verdict}${r.replayed ? "  (replay: nothing was consumed again)" : ""}`);
  console.log(levelLine(userId, r.user));
  console.log(levelLine("account", r.account));
  note(`why: ${why}`);

  const ok =
    r.accepted === expected.accepted &&
    (expected.reason === undefined || r.reason === expected.reason) &&
    (expected.scope === undefined || r.scope === expected.scope) &&
    (expected.replayed === undefined || r.replayed === expected.replayed);
  if (!ok) {
    mismatches++;
    console.log("    !! UNEXPECTED RESULT");
  }
}

async function main() {
  console.log(`Usage metering demo against ${BASE_URL}`);
  await client.waitUntilReady();

  title("Setup: one account with two users on different plans");
  const created = await client.createAccount("DocuCorp");
  client.setApiKey(created.apiKey); // from here on the account is identified by its API key only
  console.log(`Account "${created.account.name}" created. API key (shown once): ${created.apiKey.slice(0, 8)}...`);

  const team = await client.createPlan({ kind: "account", name: "Team-100", monthlyAllowance: 100, maxPerRequest: 50 });
  await client.setAccountPlan(team.id);
  const basic = await client.createPlan({ kind: "user", name: "Basic-Demo", monthlyAllowance: 40, maxPerRequest: 10 });
  const premium = await client.createPlan({ kind: "user", name: "Premium-Demo", monthlyAllowance: 80, maxPerRequest: 30 });
  await client.createUser("alice", basic.id);
  await client.createUser("bob", premium.id);
  note("account plan Team-100   : 100 units/month, max 50 per request (shared by all users)");
  note("alice  plan Basic-Demo  :  40 units/month, max 10 per request");
  note("bob    plan Premium-Demo:  80 units/month, max 30 per request");

  title("Accounting: user limits and the shared account limit");
  await attempt("alice", 10, "demo-1", { accepted: true }, "within every limit; both alice and the account are charged 10.");
  await attempt("alice", 15, "demo-2", { accepted: false, reason: "PER_REQUEST_LIMIT_EXCEEDED", scope: "user" },
    "alice's plan allows at most 10 per request. Nothing is consumed.");
  await attempt("bob", 30, "demo-3", { accepted: true }, "bob's plan allows 30 per request.");
  await attempt("bob", 30, "demo-4", { accepted: true }, "bob is now at 60/80; the account is at 70/100.");
  await attempt("alice", 10, "demo-5", { accepted: true }, "alice is at 20/40.");
  await attempt("alice", 10, "demo-6", { accepted: true }, "alice is at 30/40; the shared account is at 90/100.");
  await attempt("bob", 20, "demo-7", { accepted: false, reason: "MONTHLY_ALLOWANCE_EXCEEDED", scope: "account" },
    "bob still has 20 left himself, but the SHARED account has only 10 left.");

  title("Retries are safe (idempotency)");
  await attempt("alice", 10, "demo-1", { accepted: true, replayed: true },
    "same requestId as step 1: the original decision is returned and nothing is charged twice.");

  title("Changing plans: the client code does not change");
  const raised = await client.updatePlan(team.id, { monthlyAllowance: 200 });
  note(`account plan ${raised.name} updated to ${raised.monthlyAllowance} units/month.`);
  await attempt("bob", 20, "demo-8", { accepted: true },
    "the same request that was rejected in step 7 is accepted now. Usage was kept, not reset.");

  await client.setUserPlan("alice", premium.id);
  note("alice switched from Basic-Demo to Premium-Demo.");
  await attempt("alice", 15, "demo-9", { accepted: true },
    "15 was rejected in step 2. Her earlier usage (30) is preserved: 30 + 15 = 45.");

  title("Final usage (current UTC month)");
  const [acc, alice, bob] = await Promise.all([client.accountUsage(), client.userUsage("alice"), client.userUsage("bob")]);
  console.log(levelLine("alice", alice.user));
  console.log(levelLine("bob", bob.user));
  console.log(levelLine("account", acc));

  const sumOk = acc.consumed === alice.user.consumed + bob.user.consumed;
  console.log(`\naccount total (${acc.consumed}) = alice (${alice.user.consumed}) + bob (${bob.user.consumed}): ${sumOk ? "OK" : "MISMATCH"}`);
  const finalOk = alice.user.consumed === 45 && bob.user.consumed === 80 && acc.consumed === 125;
  if (!sumOk || !finalOk) mismatches++;

  if (mismatches > 0) {
    console.error(`\n${mismatches} unexpected result(s).`);
    process.exit(1);
  }
  console.log("\nDemo finished: every decision matched the expected business rules.");
}

main().catch((err) => {
  console.error("Demo failed:", err instanceof ApiError ? err.message : err);
  process.exit(1);
});
