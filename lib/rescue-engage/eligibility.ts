import "server-only";
import { getPool } from "../db";
import { mapLeadFacts, type LeadForAnalysis } from "../rescue-analysis/store";
import { buildTemplateDraft } from "../rescue-analysis/message-content.ts";
import type { AudienceFilters, CampaignChannel, CampaignTone } from "./campaign-schema.ts";
import { interpolateBookingLink } from "./booking-link.ts";

/**
 * Campaign audience computation with full exclusion accounting. The same
 * classification runs for the pre-activation preview and for activation itself,
 * so what the human confirmed is exactly what gets enrolled.
 *
 * Safety precedence (a lead lands in the FIRST bucket that applies):
 *   suppressed → opted-out → do-not-contact/invalid-duplicate category →
 *   closed stage (won/lost/suppressed) → invalid contact for the channel → eligible.
 * Suppressed and opted-out contacts are never eligible, under any filter combination.
 */

export type AudienceAccounting = {
  poolTotal: number;
  eligible: number;
  suppressed: number;
  optedOut: number;
  doNotContact: number;
  invalidDuplicate: number;
  closedStage: number;
  invalidContact: number;
  alreadyEnrolled: number;
  missingConsent: number; // informational: eligible leads whose consent status is 'unknown'
};

export type AudiencePreview = {
  accounting: AudienceAccounting;
  eligibleLeadIds: string[];
  sampleLeads: LeadForAnalysis[];
};

const FACT_COLUMNS = `l.id, l.first_name, l.last_name, l.email, l.email_normalized, l.phone, l.phone_normalized,
  l.address, l.city, l.state, l.zip, l.project_type, l.project_description, l.estimated_value, l.source, l.source_detail,
  l.first_contact_date::text AS first_contact_date, l.last_contact_date::text AS last_contact_date,
  l.estimate_date::text AS estimate_date, l.consent_status, l.suppressed, l.suppression_reason, l.status, l.notes`;

export async function computeAudience(
  organizationId: string,
  campaignId: string | null,
  channel: CampaignChannel,
  audience: AudienceFilters,
): Promise<AudiencePreview> {
  const params: unknown[] = [organizationId];
  const where: string[] = ["l.organization_id = $1"];
  if (audience.categories.length > 0) {
    params.push(audience.categories);
    where.push(`l.category = ANY($${params.length}::text[])`);
  }
  if (audience.minScore != null) {
    params.push(audience.minScore);
    where.push(`l.score >= $${params.length}`);
  }
  if (audience.projectTypes.length > 0) {
    params.push(audience.projectTypes.map((p) => p.toLowerCase()));
    where.push(`lower(coalesce(l.project_type, '')) = ANY($${params.length}::text[])`);
  }
  if (audience.sources.length > 0) {
    params.push(audience.sources.map((s) => s.toLowerCase()));
    where.push(`lower(coalesce(l.source, '')) = ANY($${params.length}::text[])`);
  }
  if (audience.importId) {
    params.push(audience.importId);
    where.push(`l.import_id = $${params.length}`);
  }

  let enrolledJoin = "LEFT JOIN (SELECT NULL::uuid AS lead_id) e ON false";
  if (campaignId) {
    params.push(campaignId);
    enrolledJoin = `LEFT JOIN rescue_campaign_leads e ON e.campaign_id = $${params.length} AND e.lead_id = l.id AND e.organization_id = l.organization_id`;
  }

  const contactInvalid = channel === "sms" ? "l.phone_normalized IS NULL" : "l.email_normalized IS NULL";
  const { rows } = await getPool().query(
    `SELECT ${FACT_COLUMNS}, l.score, l.category, l.pipeline_stage, (e.lead_id IS NOT NULL) AS already_enrolled,
       CASE
         WHEN l.suppressed THEN 'suppressed'
         WHEN l.consent_status = 'opted_out' THEN 'opted_out'
         WHEN l.category = 'do_not_contact' THEN 'do_not_contact'
         WHEN l.category = 'invalid_duplicate' THEN 'invalid_duplicate'
         WHEN l.pipeline_stage IN ('won', 'lost', 'suppressed') THEN 'closed_stage'
         WHEN ${contactInvalid} THEN 'invalid_contact'
         WHEN e.lead_id IS NOT NULL THEN 'already_enrolled'
         ELSE 'eligible'
       END AS bucket
     FROM rescue_leads l ${enrolledJoin}
     WHERE ${where.join(" AND ")}
     ORDER BY l.score DESC NULLS LAST, l.created_at DESC
     LIMIT 10000`,
    params,
  );

  const accounting: AudienceAccounting = {
    poolTotal: rows.length,
    eligible: 0,
    suppressed: 0,
    optedOut: 0,
    doNotContact: 0,
    invalidDuplicate: 0,
    closedStage: 0,
    invalidContact: 0,
    alreadyEnrolled: 0,
    missingConsent: 0,
  };
  const eligibleLeadIds: string[] = [];
  const sampleLeads: LeadForAnalysis[] = [];
  for (const row of rows) {
    switch (row.bucket) {
      case "suppressed": accounting.suppressed += 1; break;
      case "opted_out": accounting.optedOut += 1; break;
      case "do_not_contact": accounting.doNotContact += 1; break;
      case "invalid_duplicate": accounting.invalidDuplicate += 1; break;
      case "closed_stage": accounting.closedStage += 1; break;
      case "invalid_contact": accounting.invalidContact += 1; break;
      case "already_enrolled": accounting.alreadyEnrolled += 1; break;
      default: {
        accounting.eligible += 1;
        if (row.consent_status === "unknown") accounting.missingConsent += 1;
        eligibleLeadIds.push(row.id);
        if (sampleLeads.length < 3) sampleLeads.push(mapLeadFacts(row));
      }
    }
  }
  return { accounting, eligibleLeadIds, sampleLeads };
}

export type SampleMessage = {
  leadId: string;
  leadName: string;
  subject: string | null;
  body: string;
};

/** Deterministic sample messages for the preview — built from stored facts only, via the template engine. */
export function buildSampleMessages(
  sampleLeads: LeadForAnalysis[],
  opts: {
    channel: CampaignChannel;
    tone: CampaignTone;
    objective: string | null;
    orgName: string;
    /** Resolves the booking URL for a given lead (per-lead /book token). Optional for callers without booking context. */
    resolveBookingLinkFor?: (leadId: string) => string;
  },
): SampleMessage[] {
  return sampleLeads.map((lead) => {
    const bookingLink = opts.resolveBookingLinkFor?.(lead.id) ?? "";
    const content = buildTemplateDraft(opts.channel, lead, {
      orgName: opts.orgName,
      tone: opts.tone,
      objective: opts.objective ?? undefined,
      includeOptOutLanguage: true,
      bookingLink: bookingLink || undefined,
    });
    return {
      leadId: lead.id,
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unnamed lead",
      subject: typeof content.subject === "string" ? interpolateBookingLink(content.subject, bookingLink) : null,
      body: interpolateBookingLink(String(content.body ?? ""), bookingLink),
    };
  });
}
