import { getPool } from "@/lib/db";
import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1 } from "@/lib/public-api/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/usage — daily API request counts for the last 30 days. Scope: usage:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "usage:read");
  const { rows } = await getPool().query(
    `SELECT day, requests FROM api_usage_counters
     WHERE organization_id = $1 AND day >= CURRENT_DATE - INTERVAL '30 days'
     ORDER BY day DESC`,
    [ctx.org.id],
  );
  const days = rows.map((row) => ({ day: new Date(row.day).toISOString().slice(0, 10), requests: Number(row.requests) }));
  return NextResponse.json(
    { data: { days, total_requests_30d: days.reduce((sum, d) => sum + d.requests, 0) } },
    { headers: ctx.rateHeaders },
  );
});
