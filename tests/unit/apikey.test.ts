import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../../src/domain/apikey.js";

describe("api key helpers", () => {
  it("generates keys with the mk_ prefix and 256 bits of randomness", () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^mk_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(46);
  });

  it("returns a deterministic 64-char hex SHA-256 hash that differs from the key", () => {
    const { key, hash } = generateApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(key);
    expect(hashApiKey(key)).toBe(hash);
  });

  it("uses the first 8 characters as a non-secret prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toBe(key.slice(0, 8));
    expect(prefix).toHaveLength(8);
  });

  it("never generates the same key twice (1000 samples)", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1000);
  });

  it("produces different hashes for different keys", () => {
    expect(hashApiKey("mk_a")).not.toBe(hashApiKey("mk_b"));
  });
});
