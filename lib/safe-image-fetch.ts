import "server-only";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { checkLogoUrl, isPrivateAddress } from "./logo-url-core";

/**
 * SSRF-guarded fetch of a tenant-controlled image URL.
 *
 * Org logo URLs are stored by tenants/admins, so the server must never issue
 * an arbitrary request from them. This fetcher:
 *   1. re-validates the URL shape (http/https, public hostname, no IP literals)
 *   2. resolves DNS itself and rejects any private/loopback/link-local address
 *   3. pins the TCP connection to the vetted IP (Host/SNI still carry the
 *      hostname) so a rebinding DNS answer after the check cannot redirect
 *      the request into the internal network
 *   4. refuses redirects — a public host 302ing to an internal target would
 *      otherwise bypass the checks.
 */

export class UnsafeImageUrlError extends Error {}

const MAX_BYTES = 8 * 1024 * 1024;

export async function fetchPublicImage(rawUrl: string, timeoutMs = 5000): Promise<Buffer> {
  const verdict = checkLogoUrl(rawUrl);
  if (!verdict.ok || verdict.kind !== "absolute") throw new UnsafeImageUrlError(verdict.ok ? "Relative URL" : verdict.reason);

  const url = new URL(rawUrl);
  const { address, family } = await lookup(url.hostname);
  if (isPrivateAddress(address)) throw new UnsafeImageUrlError(`Resolved to a private address`);

  const isHttps = url.protocol === "https:";
  const request = isHttps ? https.request : http.request;

  return await new Promise<Buffer>((resolve, reject) => {
    const req = request(
      {
        host: address, // pinned: connect to the address we vetted
        family,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Host: url.host, Accept: "image/*", "User-Agent": "MogulForge-FaviconBot/1.0" },
        servername: isHttps ? url.hostname : undefined, // SNI + cert validation against the real hostname
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`image fetch failed: ${res.statusCode}`)); // redirects included — never followed
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            req.destroy(new Error("image too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("image fetch timed out")));
    req.on("error", reject);
    req.end();
  });
}
