import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getPool } from "../db";
import { PublicApiError } from "./http";

/**
 * Idempotency-Key handling for sensitive public API writes.
 *
 * Concurrency-safe: the first request atomically RESERVES the key (INSERT ..
 * ON CONFLICT DO NOTHING) before running any side effects. Concurrent
 * duplicates lose the insert race and get 409 idempotency_in_progress until
 * the winner stores its response; later retries replay the stored response.
 * If the winning request fails, it releases the reservation so the client can
 * retry; reservations abandoned by a crashed process are taken over after a
 * 5-minute grace period.
 */

export function hashRequestBody(body: unknown) {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export type IdempotencyContext = {
  key: string | null;
  endpoint: string;
  requestHash: string;
  organizationId: string;
  /** True when this request holds the reservation and must store or release it. */
  reserved: boolean;
};

/**
 * Reserves the idempotency key for this request, or returns the stored
 * response when the key was already completed. Callers that receive
 * `reserved: true` MUST later call `storeIdempotentResponse` on success or
 * `releaseIdempotency` on failure.
 */
export async function checkIdempotency(
  organizationId: string,
  endpoint: string,
  request: Request,
  body: unknown,
): Promise<{ replay: NextResponse | null; ctx: IdempotencyContext }> {
  const key = request.headers.get("idempotency-key")?.trim() || null;
  const ctx: IdempotencyContext = { key, endpoint, requestHash: hashRequestBody(body), organizationId, reserved: false };
  if (!key) return { replay: null, ctx };
  if (key.length > 255) throw new PublicApiError(400, "invalid_idempotency_key", "Idempotency-Key must be at most 255 characters.");

  const pool = getPool();

  // Atomic reservation: exactly one concurrent request wins this insert.
  const inserted = await pool.query(
    `INSERT INTO api_idempotency_keys (organization_id, endpoint, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, endpoint, idempotency_key) DO NOTHING
     RETURNING id`,
    [organizationId, endpoint, key, ctx.requestHash],
  );
  if (inserted.rows[0]) {
    ctx.reserved = true;
    return { replay: null, ctx };
  }

  const { rows } = await pool.query(
    `SELECT request_hash, response_status, response_body, created_at FROM api_idempotency_keys
     WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
    [organizationId, endpoint, key],
  );
  const existing = rows[0];
  if (!existing) {
    // Raced with a release; the client should simply retry.
    throw new PublicApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed. Retry shortly.");
  }
  if (existing.request_hash !== ctx.requestHash) {
    throw new PublicApiError(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request body.");
  }
  if (existing.response_status == null) {
    // Original request still in flight — unless it was abandoned by a crashed
    // process, in which case this request takes over the reservation.
    const takeover = await pool.query(
      `UPDATE api_idempotency_keys SET created_at = now()
       WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3
         AND response_status IS NULL AND created_at < now() - interval '5 minutes'
       RETURNING id`,
      [organizationId, endpoint, key],
    );
    if (takeover.rows[0]) {
      ctx.reserved = true;
      return { replay: null, ctx };
    }
    throw new PublicApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed.");
  }
  return {
    replay: NextResponse.json(existing.response_body, { status: existing.response_status, headers: { "Idempotency-Replayed": "true" } }),
    ctx,
  };
}

/** Stores the response for future replays, completing the reservation. No-op without a key. */
export async function storeIdempotentResponse(ctx: IdempotencyContext, status: number, responseBody: unknown) {
  if (!ctx.key) return;
  await getPool()
    .query(
      `UPDATE api_idempotency_keys SET response_status = $4, response_body = $5
       WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [ctx.organizationId, ctx.endpoint, ctx.key, status, JSON.stringify(responseBody ?? null)],
    )
    .catch((error) => console.error("Failed to store idempotent response", error));
}

/**
 * Releases a reservation after the underlying operation failed, so the client
 * can retry with the same key. Only removes still-pending reservations.
 */
export async function releaseIdempotency(ctx: IdempotencyContext) {
  if (!ctx.key || !ctx.reserved) return;
  await getPool()
    .query(
      `DELETE FROM api_idempotency_keys
       WHERE organization_id = $1 AND endpoint = $2 AND idempotency_key = $3 AND response_status IS NULL`,
      [ctx.organizationId, ctx.endpoint, ctx.key],
    )
    .catch((error) => console.error("Failed to release idempotency reservation", error));
}

/**
 * Runs an idempotent write: reserves the key, executes `work`, stores the
 * response for replays, and releases the reservation when `work` throws.
 * Returns the replayed response directly when the key already completed.
 */
export async function withIdempotency(
  organizationId: string,
  endpoint: string,
  request: Request,
  body: unknown,
  work: () => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>,
): Promise<NextResponse> {
  const { replay, ctx } = await checkIdempotency(organizationId, endpoint, request, body);
  if (replay) return replay;
  try {
    const result = await work();
    await storeIdempotentResponse(ctx, result.status, result.body);
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch (error) {
    await releaseIdempotency(ctx);
    throw error;
  }
}
