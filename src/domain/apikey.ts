import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "mk_";

/** SHA-256 is appropriate here: keys are 256 bits of randomness, not human passwords. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
}
