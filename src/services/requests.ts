import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { AppError } from "../errors.js";

type RequestRow = {
  id: string;
  request_id: string;
  user_id: string;
  units: number;
  accepted: boolean;
  reason: string | null;
  scope: string | null;
  period: string;
  applied_limits: { account?: unknown; user?: unknown } | null;
  created_iso: string;
};

// created_at is read back as TEXT with microseconds. A JS Date only has milliseconds,
// so passing it through Date would lose precision and break the cursor.
const SELECT_COLUMNS = sql`
  id, request_id, user_id, units, accepted, reason, scope,
  to_char(period_start, 'YYYY-MM') AS period,
  applied_limits,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_iso`;

function toDto(r: RequestRow) {
  return {
    requestId: r.request_id,
    userId: r.user_id,
    units: r.units,
    accepted: r.accepted,
    reason: r.reason,
    scope: r.scope,
    period: r.period,
    createdAt: r.created_iso,
    // The limits and usage as they were when the decision was made (never recomputed).
    account: r.applied_limits?.account ?? null,
    user: r.applied_limits?.user ?? null,
  };
}

const cursorSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: z.string().uuid(),
});
type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Invalid cursor.");
  }
}

export interface ListOptions {
  userId?: string;
  accepted?: boolean;
  limit: number;
  cursor?: string;
}

/** Newest first. Keyset pagination on (created_at, id): no OFFSET, stable while new rows arrive. */
export async function listRequests(db: Db, accountId: string, opts: ListOptions) {
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  const res = await db.execute<RequestRow>(sql`
    SELECT ${SELECT_COLUMNS}
    FROM usage_requests
    WHERE account_id = ${accountId}
    ${opts.userId !== undefined ? sql`AND user_id = ${opts.userId}` : sql``}
    ${opts.accepted !== undefined ? sql`AND accepted = ${opts.accepted}` : sql``}
    ${cursor ? sql`AND (created_at, id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${opts.limit + 1}`);

  // We fetched one extra row only to know whether another page exists.
  const page = res.rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  const hasMore = res.rows.length > opts.limit;

  return {
    requests: page.map(toDto),
    nextCursor: hasMore && last ? encodeCursor({ t: last.created_iso, id: last.id }) : null,
  };
}

export async function getRequest(db: Db, accountId: string, requestId: string) {
  const res = await db.execute<RequestRow>(sql`
    SELECT ${SELECT_COLUMNS}
    FROM usage_requests
    WHERE account_id = ${accountId} AND request_id = ${requestId}`);
  const row = res.rows[0];
  if (!row) throw new AppError(404, "REQUEST_NOT_FOUND", "Request not found.");
  return toDto(row);
}
