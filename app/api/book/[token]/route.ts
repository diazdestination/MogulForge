import { NextResponse } from "next/server";
import { verifyBookingToken } from "@/lib/booking-token";
import { getOrganizationById } from "@/lib/tenant";
import { intakeLead, normalizeEmail, normalizePhone } from "@/lib/public-api/lead-intake";
import { createAppointment, findLeadIdByEmail, getCampaign, getLeadEngagement, logActivity, setLeadStage } from "@/lib/rescue-engage/store";
import { pushAppointmentToCalendar } from "@/lib/calendar/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/**
 * Public booking endpoint behind a signed org booking token (shared in
 * campaign messages). Matches the visitor to an existing lead by token claim
 * or email/phone, creating a new lead when none matches, then records the
 * appointment (provider 'booking_url') and pushes it to the org's calendar.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { token } = await params;
  const check = verifyBookingToken(token);
  if (!check.ok) return NextResponse.json({ error: "This booking link is invalid." }, { status: 404 });
  const org = await getOrganizationById(check.claims.org);
  if (!org) return NextResponse.json({ error: "This booking link is no longer active." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 160) : "";
  const email = normalizeEmail(typeof body.email === "string" ? body.email : null);
  const phone = normalizePhone(typeof body.phone === "string" ? body.phone : null);
  const scheduledStart = typeof body.scheduledStart === "string" ? body.scheduledStart : "";
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";
  if (!name) return NextResponse.json({ error: "Please tell us your name." }, { status: 400 });
  if (!email && !phone) return NextResponse.json({ error: "Please provide an email or phone number." }, { status: 400 });
  const startMs = Date.parse(scheduledStart);
  if (!scheduledStart || Number.isNaN(startMs)) return NextResponse.json({ error: "Please pick a date and time." }, { status: 400 });
  if (startMs < Date.now() - 60_000) return NextResponse.json({ error: "Please pick a time in the future." }, { status: 400 });

  // Resolve the lead: token claim first, then email match, then create.
  let leadId: string | null = null;
  if (check.claims.lead) {
    const engagement = await getLeadEngagement(org.id, check.claims.lead);
    if (engagement) leadId = check.claims.lead;
  }
  if (!leadId && email) leadId = await findLeadIdByEmail(org.id, email);
  if (!leadId) {
    const [firstName, ...rest] = name.split(/\s+/);
    const intake = await intakeLead(org.id, {
      firstName,
      lastName: rest.join(" ") || null,
      email,
      phone,
      source: "booking_link",
      sourceDetail: "Public booking page",
      notes: notes || null,
      consentStatus: "implied",
    });
    if (intake.outcome === "invalid") return NextResponse.json({ error: intake.message }, { status: 400 });
    leadId = intake.leadId;
  }

  // Campaign attribution: when the link was minted for a campaign message,
  // record which campaign drove the booking — but only after confirming the
  // claimed campaign actually belongs to this org (a token is long-lived and
  // the campaign may have been deleted since it was sent).
  let campaignId: string | null = null;
  if (check.claims.cmp) {
    const campaign = await getCampaign(org.id, check.claims.cmp);
    if (campaign) campaignId = campaign.id;
  }

  const appointment = await createAppointment({
    organizationId: org.id,
    leadId,
    campaignId,
    appointmentType: "estimate",
    scheduledStart: new Date(startMs).toISOString(),
    notes: notes || null,
    createdBy: null,
    provider: "booking_url",
  });
  if (!appointment) return NextResponse.json({ error: "The appointment could not be booked. Please try again." }, { status: 500 });

  const engagement = await getLeadEngagement(org.id, leadId);
  if (engagement && ["imported", "cleaned", "analyzed", "approved", "contacted", "replied", "qualified"].includes(engagement.pipelineStage)) {
    await setLeadStage(org.id, leadId, "appointment_booked");
  }
  await logActivity({
    organizationId: org.id,
    leadId,
    campaignId,
    activityType: "appointment_booked",
    title: campaignId ? "Appointment requested via campaign booking link" : "Appointment requested via booking link",
    detail: `Scheduled for ${new Date(startMs).toISOString()}`,
    actorUserId: null,
  });
  await pushAppointmentToCalendar(org.id, appointment.id);
  return NextResponse.json({ ok: true }, { status: 201 });
}
