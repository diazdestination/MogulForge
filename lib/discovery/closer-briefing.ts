import "server-only";
import { getPool } from "@/lib/db";
import { getOpenAIClient } from "@/lib/openai";

export type CloserBriefing = {
  leadId: string;
  briefingText: string | null;
  generatedAt: string;
  error: string | null;
};

/** Returns the cached briefing for a lead, or null if none has been generated yet. */
export async function getCachedBriefing(organizationId: string, leadId: string): Promise<CloserBriefing | null> {
  const { rows } = await getPool().query(
    `SELECT lead_id, briefing_text, generated_at, error
     FROM lead_closer_briefings WHERE lead_id=$1 AND organization_id=$2`,
    [leadId, organizationId],
  );
  if (rows.length === 0) return null;
  return {
    leadId: String(rows[0].lead_id),
    briefingText: rows[0].briefing_text ? String(rows[0].briefing_text) : null,
    generatedAt: String(rows[0].generated_at),
    error: rows[0].error ? String(rows[0].error) : null,
  };
}

/**
 * Generates (or regenerates) an AI closer briefing for the lead.
 * Assembles context from the lead record, AI analysis, and recent activities.
 * Always caches the result (or error) in lead_closer_briefings.
 */
export async function generateCloserBriefing(organizationId: string, leadId: string): Promise<CloserBriefing> {
  const [leadRes, activitiesRes] = await Promise.all([
    getPool().query(
      `SELECT first_name, last_name, city, state, project_type, project_description,
              estimated_value, source, source_detail, first_contact_date, last_contact_date,
              estimate_date, pipeline_stage, score, category, analysis, notes
       FROM rescue_leads WHERE id=$1 AND organization_id=$2`,
      [leadId, organizationId],
    ),
    getPool().query(
      `SELECT title, detail, created_at FROM rescue_activities
       WHERE lead_id=$1 AND organization_id=$2 ORDER BY created_at DESC LIMIT 10`,
      [leadId, organizationId],
    ),
  ]);

  if (leadRes.rows.length === 0) {
    return { leadId, briefingText: null, generatedAt: new Date().toISOString(), error: "Lead not found" };
  }

  const lead = leadRes.rows[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb from DB
  const analysis = lead.analysis as any;
  const aiSummary: string = analysis?.final?.summary ?? "";
  const recommendedAction: string = analysis?.final?.recommendedAction ?? "";
  const recommendedChannel: string = analysis?.final?.recommendedChannel ?? "";
  const riskFlags: string[] = Array.isArray(analysis?.final?.riskFlags) ? (analysis.final.riskFlags as string[]) : [];

  const lines = [
    `Lead: ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown"}${[lead.city, lead.state].filter(Boolean).length ? ` — ${[lead.city, lead.state].filter(Boolean).join(", ")}` : ""}`,
    lead.project_type ? `Service interest: ${String(lead.project_type)}` : null,
    lead.project_description ? `Description: ${String(lead.project_description).slice(0, 300)}` : null,
    lead.estimated_value ? `Estimated value: $${Math.round(Number(lead.estimated_value)).toLocaleString()}` : null,
    `Pipeline stage: ${String(lead.pipeline_stage)}`,
    lead.score != null ? `AI score: ${String(lead.score)}/10 (${String(lead.category ?? "unknown")})` : null,
    aiSummary ? `AI analysis: ${aiSummary}` : null,
    recommendedAction ? `Recommended action: ${recommendedAction}` : null,
    recommendedChannel ? `Best channel: ${recommendedChannel}` : null,
    riskFlags.length > 0 ? `Risk flags: ${riskFlags.join(", ")}` : null,
    lead.source ? `Source: ${String(lead.source)}${lead.source_detail ? ` (${String(lead.source_detail)})` : ""}` : null,
    lead.first_contact_date ? `First contact: ${String(lead.first_contact_date).slice(0, 10)}` : null,
    lead.last_contact_date ? `Last contact: ${String(lead.last_contact_date).slice(0, 10)}` : null,
    lead.estimate_date ? `Estimate sent: ${String(lead.estimate_date).slice(0, 10)}` : null,
    lead.notes ? `Notes: ${String(lead.notes).slice(0, 300)}` : null,
    activitiesRes.rows.length > 0
      ? `Recent activity:\n${activitiesRes.rows.map((a) => `  - [${String(a.created_at).slice(0, 10)}] ${String(a.title)}${a.detail ? `: ${String(a.detail).slice(0, 200)}` : ""}`).join("\n")}`
      : null,
  ].filter(Boolean);

  try {
    const ai = getOpenAIClient();
    const completion = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            "You are a sales closer assistant. Given a lead profile, write a concise 3-5 bullet briefing for the salesperson about to contact this lead. Cover: why this lead deserves attention right now, what the client is likely looking for, any time-sensitive factors, the best angle or channel, and risks to watch. Be specific and actionable. Output only bullet points — no headers, no preamble.",
        },
        { role: "user", content: `Lead profile:\n\n${lines.join("\n")}\n\nWrite the closer briefing.` },
      ],
    });
    const briefingText = completion.choices[0]?.message?.content?.trim() ?? null;

    await getPool().query(
      `INSERT INTO lead_closer_briefings (lead_id, organization_id, briefing_text, generated_at, error)
       VALUES ($1, $2, $3, now(), NULL)
       ON CONFLICT (lead_id) DO UPDATE
         SET briefing_text=EXCLUDED.briefing_text, generated_at=now(), error=NULL, organization_id=EXCLUDED.organization_id`,
      [leadId, organizationId, briefingText],
    );
    return { leadId, briefingText, generatedAt: new Date().toISOString(), error: null };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "AI generation failed";
    await getPool()
      .query(
        `INSERT INTO lead_closer_briefings (lead_id, organization_id, briefing_text, generated_at, error)
         VALUES ($1, $2, NULL, now(), $3)
         ON CONFLICT (lead_id) DO UPDATE
           SET briefing_text=NULL, generated_at=now(), error=EXCLUDED.error, organization_id=EXCLUDED.organization_id`,
        [leadId, organizationId, msg],
      )
      .catch(() => {});
    return { leadId, briefingText: null, generatedAt: new Date().toISOString(), error: msg };
  }
}

/** Organic wins: leads at appointment/estimate/won stage (no ad attribution yet — all are organic). */
export async function getOrganicWins(
  organizationId: string,
): Promise<{ count: number; wonRevenue: number }> {
  const { rows } = await getPool().query(
    `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(CASE WHEN pipeline_stage='won' THEN won_value ELSE 0 END), 0) AS won_rev
     FROM rescue_leads
     WHERE organization_id=$1
       AND pipeline_stage IN ('appointment_booked','estimate_issued','won')
       AND suppressed = false`,
    [organizationId],
  );
  return {
    count: parseInt(String(rows[0]?.cnt ?? "0"), 10),
    wonRevenue: parseFloat(String(rows[0]?.won_rev ?? "0")),
  };
}
