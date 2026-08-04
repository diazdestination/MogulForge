import { buildBookingUrl } from "../booking-token.ts";

/**
 * Booking-link placeholder support for campaign messages. Pure module —
 * directly unit-testable (no server-only imports).
 *
 * Reps insert the literal `{{booking_link}}` placeholder into a campaign's
 * booking-link field (one click in the editor). At send time it resolves,
 * per lead, to a signed Revenue Rescue /book/<token> URL minted with that
 * lead's id — so the org knows exactly who booked — falling back to the
 * org's saved default booking link, then the Calendly URL, when a Revenue
 * Rescue booking URL cannot be minted (no base URL / no signing secret).
 */

export const BOOKING_LINK_PLACEHOLDER = "{{booking_link}}";

const PLACEHOLDER_RE = /\{\{\s*booking_link\s*\}\}/gi;

/** True when the text contains the {{booking_link}} placeholder (whitespace/case tolerant). */
export function containsBookingPlaceholder(text: string | null | undefined): boolean {
  return typeof text === "string" && /\{\{\s*booking_link\s*\}\}/i.test(text);
}

/** True when the value is nothing but the placeholder ("resolve automatically"). */
export function isBookingPlaceholderOnly(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\{\{\s*booking_link\s*\}\}$/i.test(value.trim());
}

/**
 * Replaces every {{booking_link}} occurrence with `url`. When no URL could be
 * resolved, the placeholder is stripped and leftover doubled spaces collapsed
 * so a raw "{{booking_link}}" never reaches a customer.
 */
export function interpolateBookingLink(text: string, url: string): string {
  if (!containsBookingPlaceholder(text)) return text;
  const replaced = text.replace(PLACEHOLDER_RE, url);
  if (url) return replaced;
  return replaced
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n");
}

export type ResolveBookingLinkInput = {
  organizationId: string;
  /** The specific lead this message goes to (per-lead booking token), or null. */
  leadId: string | null;
  /** The campaign's booking-link field: a literal URL, the placeholder, or empty. */
  campaignBookingLink: string | null;
  /** Org settings fallbacks. */
  defaultBookingLink: string;
  calendlyUrl: string;
  /** Public base URL for minting /book/<token> links, or null when unknown. */
  baseUrl: string | null;
};

/**
 * Resolves the booking URL for one outgoing message:
 * 1. a literal URL typed into the campaign's booking-link field wins;
 * 2. otherwise a Revenue Rescue /book/<token> URL is minted for this lead;
 * 3. otherwise the org's saved default booking link, then its Calendly URL;
 * 4. otherwise "" (the placeholder is stripped from the message).
 */
export function resolveBookingLink(input: ResolveBookingLinkInput): string {
  const literal = (input.campaignBookingLink ?? "").trim();
  if (literal !== "" && !containsBookingPlaceholder(literal)) return literal;
  if (input.baseUrl) {
    const minted = buildBookingUrl(input.baseUrl, input.organizationId, input.leadId);
    if (minted) return minted;
  }
  const fallback = input.defaultBookingLink.trim() || input.calendlyUrl.trim();
  return containsBookingPlaceholder(fallback) ? "" : fallback;
}

/** Public base URL of the app (PUBLIC_BASE_URL, else the first Replit domain), or null. */
export function publicBaseUrl(): string | null {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return domain ? `https://${domain}` : null;
}
