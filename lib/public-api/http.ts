import { NextResponse } from "next/server";

/**
 * Structured error + pagination helpers for the public /api/v1 surface.
 * Error shape: { error: { code, message, details? } } — stable and documented.
 */

export class PublicApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function apiErrorResponse(error: PublicApiError, headers?: Record<string, string>) {
  return NextResponse.json(
    { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
    { status: error.status, headers },
  );
}

type V1Handler<Ctx> = (request: Request, context: Ctx) => Promise<NextResponse | Response>;

/** Wraps a /api/v1 handler so thrown PublicApiErrors become structured JSON errors. */
export function guardV1<Ctx>(handler: V1Handler<Ctx>): V1Handler<Ctx> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof PublicApiError) return apiErrorResponse(error);
      console.error("Unhandled public API error", error);
      return apiErrorResponse(new PublicApiError(500, "internal_error", "Internal server error."));
    }
  };
}

export type Pagination = { limit: number; offset: number };

/** Parses ?limit= and ?offset= with sane bounds (limit 1–100, default 25). */
export function parsePagination(url: URL): Pagination {
  const rawLimit = Number(url.searchParams.get("limit") ?? 25);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  if (url.searchParams.has("limit") && (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100)) {
    throw new PublicApiError(400, "invalid_parameter", "limit must be an integer between 1 and 100.");
  }
  if (url.searchParams.has("offset") && (!Number.isInteger(rawOffset) || rawOffset < 0)) {
    throw new PublicApiError(400, "invalid_parameter", "offset must be a non-negative integer.");
  }
  return { limit: Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25, offset: Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0 };
}

/** Standard list envelope: { data, pagination: { limit, offset, total, has_more } }. */
export function listResponse<T>(data: T[], pagination: Pagination, total: number, headers?: Record<string, string>) {
  return NextResponse.json(
    {
      data,
      pagination: {
        limit: pagination.limit,
        offset: pagination.offset,
        total,
        has_more: pagination.offset + data.length < total,
      },
    },
    { headers },
  );
}

export async function readV1Json(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new PublicApiError(400, "invalid_body", "Request body must be a JSON object.");
}
