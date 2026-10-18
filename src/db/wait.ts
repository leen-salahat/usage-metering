export interface Queryable {
  query(text: string): Promise<unknown>;
}

export interface WaitOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>; // injectable so tests do not really wait
  log?: (message: string) => void;
}

/**
 * Retries a trivial query until the database answers.
 * Needed because the database container may accept connections later than the service starts.
 */
export async function waitForDb(pool: Queryable, opts: WaitOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? ((message: string) => console.log(message));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      // Node's AggregateError (IPv4 + IPv6) often has an empty message, so prefer the code.
      const e = err as { code?: string; message?: string };
      const reason = e.code ?? e.message ?? "unknown error";
      if (attempt === attempts) {
        throw new Error(`Database not reachable after ${attempts} attempts: ${reason}`);
      }
      log(`Waiting for database (attempt ${attempt}/${attempts}): ${reason}`);
      await sleep(delayMs);
    }
  }
}
