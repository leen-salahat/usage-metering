export type Scope = "account" | "user";
export type RejectionReason = "PER_REQUEST_LIMIT_EXCEEDED" | "MONTHLY_ALLOWANCE_EXCEEDED";

/** Limits of one level (account or user) plus what it consumed so far this month. */
export interface LimitState {
  monthlyAllowance: number;
  maxPerRequest: number;
  consumed: number;
}

export type Decision =
  | { accepted: true }
  | { accepted: false; reason: RejectionReason; scope: Scope };

/** Never negative: if usage exceeds a lowered allowance, remaining is 0. */
export function remaining(monthlyAllowance: number, consumed: number): number {
  return Math.max(0, monthlyAllowance - consumed);
}

/**
 * Pure business rule: both levels are evaluated independently (allowances are never added).
 * Priority when several rules fail: per-request rules first, then monthly rules;
 * within each group the user is checked before the account.
 */
export function evaluateConsumption(
  units: number,
  account: LimitState,
  user: LimitState,
): Decision {
  if (units > user.maxPerRequest) {
    return { accepted: false, reason: "PER_REQUEST_LIMIT_EXCEEDED", scope: "user" };
  }
  if (units > account.maxPerRequest) {
    return { accepted: false, reason: "PER_REQUEST_LIMIT_EXCEEDED", scope: "account" };
  }
  if (units > remaining(user.monthlyAllowance, user.consumed)) {
    return { accepted: false, reason: "MONTHLY_ALLOWANCE_EXCEEDED", scope: "user" };
  }
  if (units > remaining(account.monthlyAllowance, account.consumed)) {
    return { accepted: false, reason: "MONTHLY_ALLOWANCE_EXCEEDED", scope: "account" };
  }
  return { accepted: true };
}
