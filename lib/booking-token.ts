import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed public booking-link tokens. Stateless HMAC tokens (no DB row):
 * base64url(JSON claims) + "." + signature. A booking token identifies the
 * organization (and optionally a specific lead) so the public /book/[token]
 * page can accept bookings without a session. Booking links are shared in
 * campaign messages, so they are long-lived by design — revoke by rotating
 * SESSION_SECRET.
 *
 * Deliberately free of "server-only" so unit tests can exercise it.
 */

export type BookingClaims = {
  org: string;
  /** Optional lead id when the link was minted for a specific lead. */
  lead: string | null;
  iat: number;
};

function bookingSecret(secret?: string) {
  const value = secret ?? process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not configured");
  return `booking.${value}`;
}

function sign(payload: string, secret?: string) {
  return createHmac("sha256", bookingSecret(secret)).update(payload).digest("base64url");
}

export function issueBookingToken(
  input: { organizationId: string; leadId?: string | null },
  options?: { secret?: string; nowSeconds?: number },
): string {
  const claims: BookingClaims = {
    org: input.organizationId,
    lead: input.leadId ?? null,
    iat: options?.nowSeconds ?? Math.floor(Date.now() / 1000),
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, options?.secret)}`;
}

export type BookingTokenCheck = { ok: true; claims: BookingClaims } | { ok: false; reason: string };

export function verifyBookingToken(token: string, options?: { secret?: string }): BookingTokenCheck {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(parts[0], options?.secret));
  } catch {
    return { ok: false, reason: "unconfigured" };
  }
  const given = Buffer.from(parts[1]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };
  let claims: BookingClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as BookingClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.org !== "string" || claims.org === "") return { ok: false, reason: "malformed" };
  if (claims.lead !== null && typeof claims.lead !== "string") return { ok: false, reason: "malformed" };
  return { ok: true, claims };
}

/** Absolute booking-page URL for an org, or "" when signing is unavailable. */
export function buildBookingUrl(baseUrl: string, organizationId: string, leadId?: string | null): string {
  try {
    const token = issueBookingToken({ organizationId, leadId: leadId ?? null });
    return `${baseUrl.replace(/\/$/, "")}/book/${token}`;
  } catch {
    return "";
  }
}
