import { describe, expect, it } from "vitest";
import { evaluateConsumption, remaining, type LimitState } from "../../src/domain/quota.js";

const level = (monthlyAllowance: number, maxPerRequest: number, consumed = 0): LimitState => ({
  monthlyAllowance,
  maxPerRequest,
  consumed,
});

// Numbers from the brief: account 10,000/month and 100 per request; user 1,000/month and 20 per request.
const account = level(10_000, 100);
const user = level(1_000, 20);

describe("evaluateConsumption", () => {
  it("accepts a request that satisfies every rule", () => {
    expect(evaluateConsumption(10, account, user)).toEqual({ accepted: true });
  });

  it("rejects 25 units on the user's per-request limit (brief example)", () => {
    expect(evaluateConsumption(25, account, user)).toEqual({
      accepted: false,
      reason: "PER_REQUEST_LIMIT_EXCEEDED",
      scope: "user",
    });
  });

  it("rejects on the account's per-request limit when the user's limit allows it", () => {
    expect(evaluateConsumption(15, level(10_000, 10), user)).toEqual({
      accepted: false,
      reason: "PER_REQUEST_LIMIT_EXCEEDED",
      scope: "account",
    });
  });

  it("per-request boundary: exactly the max is accepted, max + 1 is rejected", () => {
    expect(evaluateConsumption(20, account, user).accepted).toBe(true);
    expect(evaluateConsumption(21, account, user).accepted).toBe(false);
  });

  it("monthly boundary: reaching the allowance exactly is accepted, one more is rejected", () => {
    const nearlyFull = level(1_000, 20, 990);
    expect(evaluateConsumption(10, account, nearlyFull).accepted).toBe(true);
    expect(evaluateConsumption(11, account, nearlyFull)).toEqual({
      accepted: false,
      reason: "MONTHLY_ALLOWANCE_EXCEEDED",
      scope: "user",
    });
  });

  it("rejects on the shared account allowance when only 5 are left, even if the user has plenty (brief example)", () => {
    const accountAlmostFull = level(10_000, 100, 9_995);
    expect(remaining(10_000, 9_995)).toBe(5);
    expect(evaluateConsumption(10, accountAlmostFull, user)).toEqual({
      accepted: false,
      reason: "MONTHLY_ALLOWANCE_EXCEEDED",
      scope: "account",
    });
  });

  it("rejects on the user's allowance when the user is exhausted but the account has plenty", () => {
    expect(evaluateConsumption(10, account, level(1_000, 20, 995))).toEqual({
      accepted: false,
      reason: "MONTHLY_ALLOWANCE_EXCEEDED",
      scope: "user",
    });
  });

  it("reports zero remaining (never negative) when usage exceeds a lowered allowance, and rejects", () => {
    expect(remaining(100, 150)).toBe(0);
    expect(remaining(1_000, 990)).toBe(10);
    expect(evaluateConsumption(1, account, level(100, 20, 150))).toEqual({
      accepted: false,
      reason: "MONTHLY_ALLOWANCE_EXCEEDED",
      scope: "user",
    });
  });

  it("picks a deterministic reason when several rules fail: per-request before monthly, user before account", () => {
    // user per-request AND account monthly both violated -> user per-request wins
    expect(evaluateConsumption(25, level(10, 100, 10), user)).toMatchObject({
      reason: "PER_REQUEST_LIMIT_EXCEEDED",
      scope: "user",
    });
    // account per-request AND user monthly both violated -> account per-request wins
    expect(evaluateConsumption(15, level(10_000, 10), level(1_000, 20, 1_000))).toMatchObject({
      reason: "PER_REQUEST_LIMIT_EXCEEDED",
      scope: "account",
    });
  });
});
