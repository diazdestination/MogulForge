import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared HMAC signature scheme for incoming and outgoing webhooks.
 * Signature base string: `${timestamp}.${rawBody}`; header format `v1=<hex hmac>`.
 * Pure functions — unit-testable without a database.
 */

export const SIGNATURE_HEADER = "x-revenuerescue-signature";
export const TIMESTAMP_HEADER = "x-revenuerescue-timestamp";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signWebhookPayload(secret: string, timestamp: string | number, rawBody: string) {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `v1=${mac}`;
}

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: "missing_signature" | "missing_timestamp" | "invalid_timestamp" | "timestamp_out_of_tolerance" | "signature_mismatch" };

/**
 * Verifies a signed webhook request. `nowSeconds` is injectable for tests.
 * Timestamp must be unix seconds within the tolerance window (replay protection).
 */
export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): SignatureCheck {
  const { secret, rawBody, signatureHeader, timestampHeader } = input;
  if (!signatureHeader) return { valid: false, reason: "missing_signature" };
  if (!timestampHeader) return { valid: false, reason: "missing_timestamp" };
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { valid: false, reason: "invalid_timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { valid: false, reason: "timestamp_out_of_tolerance" };

  const expected = signWebhookPayload(secret, timestampHeader, rawBody);
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "signature_mismatch" };
  return { valid: true };
}
