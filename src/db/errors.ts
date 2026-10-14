/**
 * Drizzle wraps driver errors (error.cause), so the SQLSTATE code may be one level down.
 * Common codes: 23505 unique_violation, 23503 foreign_key_violation, 23514 check_violation.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
