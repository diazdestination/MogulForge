import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * At-rest encryption for per-org calendar OAuth tokens (AES-256-GCM). The key
 * is derived from SESSION_SECRET, so rotating that secret invalidates every
 * stored token (orgs simply reconnect). Deliberately free of "server-only" so
 * unit tests can exercise it directly.
 *
 * Format: "v1." + base64url(iv[12] | authTag[16] | ciphertext)
 */

const VERSION = "v1.";
const KEY_CACHE = new Map<string, Buffer>();

function deriveKey(secret?: string): Buffer {
  const value = secret ?? process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not configured");
  let key = KEY_CACHE.get(value);
  if (!key) {
    key = scryptSync(value, "mf-calendar-token-key", 32);
    KEY_CACHE.set(value, key);
  }
  return key;
}

export function encryptToken(plaintext: string, secret?: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSION + Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

/** Returns null (never garbage) when the blob is malformed, tampered with, or encrypted under a different secret. */
export function decryptToken(blob: string, secret?: string): string | null {
  if (!blob.startsWith(VERSION)) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(blob.slice(VERSION.length), "base64url");
  } catch {
    return null;
  }
  if (raw.length < 12 + 16 + 1) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
