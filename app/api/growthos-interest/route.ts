import { NextResponse } from "next/server";

import {
  growthOSInterestSchema,
  growthOSPriorityLabels,
} from "@/lib/growthos-interest-schema";

export const dynamic = "force-dynamic";

const allowedCaptureOrigins = new Set([
  "https://app.mogulforge.ai",
  "https://mogulforge-growthos-staging.fly.dev",
]);

function getCaptureUrl(): string | null {
  const configured = process.env.GROWTHOS_CAPTURE_URL?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    const validPath = url.pathname.startsWith("/api/v1/public/capture/cap_");
    return allowedCaptureOrigins.has(url.origin) && validPath ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = growthOSInterestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Please check the form fields.",
        issues: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const captureUrl = getCaptureUrl();
  if (!captureUrl) {
    return NextResponse.json(
      { error: "Beta requests are temporarily unavailable. Please try again shortly." },
      { status: 503 },
    );
  }

  const input = parsed.data;
  const message = [
    `GrowthOS beta request from ${input.company}.`,
    `Priority: ${growthOSPriorityLabels[input.priority]}.`,
    input.website ? `Website: ${input.website}.` : null,
    input.monthlyLeads !== undefined ? `Approximate monthly leads: ${input.monthlyLeads}.` : null,
    input.notes ? `Notes: ${input.notes}` : null,
    "Consent: requested contact about the MogulForge GrowthOS beta.",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(captureUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-idempotency-key": `growthos-beta-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      fullName: input.fullName,
      workEmail: input.workEmail,
      phone: input.phone ?? "",
      message,
    }),
    cache: "no-store",
  }).catch(() => null);

  if (!response?.ok) {
    return NextResponse.json(
      { error: "We could not save your request. Please try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "You’re on the GrowthOS beta list. We’ll review your business and follow up personally.",
  });
}
