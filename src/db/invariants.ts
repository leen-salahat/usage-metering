import type pg from "pg";

export interface InvariantViolation {
  accountId: string;
  period: string;
  accountConsumed: number;
  usersSum: number;
  acceptedSum: number;
}

/**
 * For every (account, UTC month): account counter == sum of user counters == sum of accepted units.
 * One SQL statement, so it reads one consistent snapshot even while requests are running.
 */
export async function findInvariantViolations(pool: pg.Pool) {
  const { rows } = await pool.query<{
    accountId: string;
    period: string;
    accountConsumed: string;
    usersSum: string;
    acceptedSum: string;
  }>(`
    WITH keys AS (
      SELECT account_id, period_start FROM account_usage
      UNION
      SELECT account_id, period_start FROM usage_requests WHERE accepted
    )
    SELECT k.account_id AS "accountId",
           k.period_start::text AS period,
           COALESCE((SELECT a.consumed FROM account_usage a
                     WHERE a.account_id = k.account_id AND a.period_start = k.period_start), 0)::bigint AS "accountConsumed",
           COALESCE((SELECT SUM(u.consumed) FROM user_usage u
                     WHERE u.account_id = k.account_id AND u.period_start = k.period_start), 0)::bigint AS "usersSum",
           COALESCE((SELECT SUM(r.units) FROM usage_requests r
                     WHERE r.account_id = k.account_id AND r.period_start = k.period_start AND r.accepted), 0)::bigint AS "acceptedSum"
    FROM keys k
    ORDER BY k.account_id, k.period_start`);

  const all: InvariantViolation[] = rows.map((r) => ({
    accountId: r.accountId,
    period: r.period,
    accountConsumed: Number(r.accountConsumed),
    usersSum: Number(r.usersSum),
    acceptedSum: Number(r.acceptedSum),
  }));
  const violations = all.filter(
    (r) => r.accountConsumed !== r.usersSum || r.accountConsumed !== r.acceptedSum,
  );
  return { checked: all.length, violations };
}
