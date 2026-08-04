import "server-only";

/**
 * Shared helpers for the Twilio webhook routes. Twilio POSTs
 * application/x-www-form-urlencoded bodies and signs the full public URL plus
 * the sorted form parameters.
 */

export async function twilioParams(request: Request): Promise<{ params: Record<string, string>; raw: Record<string, string> }> {
  const text = await request.text();
  const search = new URLSearchParams(text);
  const raw: Record<string, string> = {};
  for (const [key, value] of search.entries()) raw[key] = value;
  return { params: raw, raw };
}

/**
 * Reconstructs the public URL Twilio signed. Behind Replit's proxy the
 * request.url host is internal, so the forwarded headers win.
 */
export function requestUrlForSignature(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}${url.pathname}${url.search}`;
}
