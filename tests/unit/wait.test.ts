import { describe, expect, it } from "vitest";
import { waitForDb } from "../../src/db/wait.js";

const fast = { sleep: async () => {}, log: () => {} };

describe("waitForDb", () => {
  it("returns immediately when the database answers on the first try", async () => {
    let calls = 0;
    await waitForDb({ query: async () => { calls++; } }, fast);
    expect(calls).toBe(1);
  });

  it("retries until the database becomes reachable", async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
    };
    await waitForDb(pool, { ...fast, attempts: 5 });
    expect(calls).toBe(3);
  });

  it("gives up with a clear error after the configured attempts", async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        throw Object.assign(new Error(""), { code: "ECONNREFUSED" });
      },
    };
    await expect(waitForDb(pool, { ...fast, attempts: 3 })).rejects.toThrow(
      /after 3 attempts: ECONNREFUSED/,
    );
    expect(calls).toBe(3);
  });
});
