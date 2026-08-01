import { embedCorsHeaders, requireEmbedSession } from "@/lib/embed/auth";
import { guardV1 } from "@/lib/public-api/http";
import { listAppointments } from "@/lib/rescue-engage/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/embed/appointments — upcoming appointments for the embedded module. */
export const GET = guardV1(async (request: Request) => {
  const { org, claims } = await requireEmbedSession(request, "appointments");
  const appointments = await listAppointments(org.id, { limit: 50 });
  const data = appointments.map((a) => ({
    id: a.id,
    appointmentType: a.appointmentType,
    scheduledStart: a.scheduledStart,
    scheduledEnd: a.scheduledEnd,
    status: a.status,
    address: a.address,
  }));
  return NextResponse.json({ data }, { headers: embedCorsHeaders(claims) });
});

export function OPTIONS(request: Request) {
  const origin = request.headers.get("origin") ?? "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin",
    },
  });
}
