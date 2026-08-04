import "server-only";
import { getPool } from "./db";
import { MANAGER_ROLES } from "./roles";
import { getOAuthAppCredentials } from "./calendar/oauth-config";
import { listOrgCalendarConnections } from "./calendar/org-connections";
import { getConnectedCalendarProviders } from "./calendar/connections";
import { listCrmConnections } from "./crm/store";
import { getOrganizationById } from "./tenant";
import { getOrgSettings } from "./org-settings";

/**
 * Guided onboarding state + live connection statuses.
 *
 * Two sources of truth, deliberately separate:
 * - org_onboarding.steps records what the user CHOSE in the wizard
 *   (done / skipped) so the flow is resumable.
 * - getOnboardingStatus() recomputes what is ACTUALLY connected right now
 *   (OAuth rows, CRM connections, lead counts, approved origins). The status
 *   screen and Settings mirror always render from these live checks — a
 *   "done" step flag is never presented as proof a connection works.
 */

export const ONBOARDING_STEPS = ["google", "leads", "website"] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepChoice = "done" | "skipped";

export function isOnboardingStep(value: string): value is OnboardingStepKey {
  return (ONBOARDING_STEPS as readonly string[]).includes(value);
}

export type OnboardingRecord = {
  /** Row exists — the org has entered the guided flow at least once. */
  started: boolean;
  steps: Partial<Record<OnboardingStepKey, OnboardingStepChoice>>;
  completedAt: string | null;
};

function mapRecord(row: { steps?: unknown; completed_at?: unknown } | undefined): OnboardingRecord {
  if (!row) return { started: false, steps: {}, completedAt: null };
  const raw = (row.steps ?? {}) as Record<string, unknown>;
  const steps: OnboardingRecord["steps"] = {};
  for (const key of ONBOARDING_STEPS) {
    if (raw[key] === "done" || raw[key] === "skipped") steps[key] = raw[key] as OnboardingStepChoice;
  }
  return {
    started: true,
    steps,
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
  };
}

/**
 * The org the onboarding wizard targets. When `preferredOrgId` is given (e.g.
 * from a ?org= resume link) and the user manages that org, it wins — multi-org
 * managers must resume the org they were actually looking at. Otherwise falls
 * back to the oldest active org the user manages (owner/admin).
 */
export async function findManagedOrganization(
  userId: string,
  preferredOrgId?: string | null,
): Promise<{ id: string; name: string; industry: string } | null> {
  const { rows } = await getPool().query(
    `SELECT o.id, o.name, o.industry FROM memberships m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND o.status = 'active' AND m.role = ANY($2)
     ORDER BY m.created_at ASC`,
    [userId, [...MANAGER_ROLES]],
  );
  const preferred = preferredOrgId ? rows.find((r) => r.id === preferredOrgId) : null;
  const row = preferred ?? rows[0];
  return row ? { id: row.id, name: row.name, industry: row.industry ?? "" } : null;
}

export async function getOnboardingRecord(organizationId: string): Promise<OnboardingRecord> {
  const { rows } = await getPool().query("SELECT steps, completed_at FROM org_onboarding WHERE organization_id = $1", [
    organizationId,
  ]);
  return mapRecord(rows[0]);
}

/** Creates the onboarding row if missing (marks the org as "in the guided flow"). */
export async function ensureOnboardingRecord(organizationId: string): Promise<void> {
  await getPool().query(
    "INSERT INTO org_onboarding (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING",
    [organizationId],
  );
}

export async function markOnboardingStep(
  organizationId: string,
  step: OnboardingStepKey,
  choice: OnboardingStepChoice,
): Promise<OnboardingRecord> {
  const { rows } = await getPool().query(
    `INSERT INTO org_onboarding (organization_id, steps)
     VALUES ($1, jsonb_build_object($2::text, $3::text))
     ON CONFLICT (organization_id) DO UPDATE SET
       steps = org_onboarding.steps || jsonb_build_object($2::text, $3::text),
       updated_at = now()
     RETURNING steps, completed_at`,
    [organizationId, step, choice],
  );
  return mapRecord(rows[0]);
}

export async function completeOnboarding(organizationId: string): Promise<OnboardingRecord> {
  const { rows } = await getPool().query(
    `INSERT INTO org_onboarding (organization_id, completed_at)
     VALUES ($1, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       completed_at = COALESCE(org_onboarding.completed_at, now()),
       updated_at = now()
     RETURNING steps, completed_at`,
    [organizationId],
  );
  return mapRecord(rows[0]);
}

// ---------------------------------------------------------------------------
// Live connection statuses (never derived from the step flags)
// ---------------------------------------------------------------------------

export type OnboardingStatus = {
  /** Platform-level Google OAuth app configured (env). False = fail closed, tell the admin. */
  googleConfigured: boolean;
  google: { connected: boolean; accountEmail: string | null };
  leads: {
    /** Active CRM connections by provider id (e.g. "hubspot"). */
    activeCrmProviders: string[];
    /** Any CRM connection rows at all (drafts count — the org started setup). */
    hasCrmConnection: boolean;
    leadCount: number;
  };
  website: { origins: string[]; websiteUrl: string };
  calendar: {
    syncProvider: string;
    /** Org signed into its own Google/Outlook account. */
    orgConnected: boolean;
    /** Legacy workspace-level connector available as fallback. */
    workspaceConnected: boolean;
    calendlyUrl: string;
  };
};

export async function getOnboardingStatus(organizationId: string): Promise<OnboardingStatus> {
  const [org, settings, orgConnections, crmConnections, workspace, leadCountRow] = await Promise.all([
    getOrganizationById(organizationId),
    getOrgSettings(organizationId),
    listOrgCalendarConnections(organizationId),
    listCrmConnections(organizationId),
    getConnectedCalendarProviders().catch(() => ({ google: false, outlook: false, calendly: false })),
    getPool().query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1", [organizationId]),
  ]);

  const google = orgConnections.find((c) => c.provider === "google_calendar") ?? null;
  const outlook = orgConnections.find((c) => c.provider === "outlook_calendar") ?? null;
  const syncProvider = settings.calendar.syncProvider;
  const orgConnected = syncProvider === "google_calendar" ? !!google : syncProvider === "outlook_calendar" ? !!outlook : !!google || !!outlook;
  const workspaceConnected =
    syncProvider === "google_calendar" ? workspace.google : syncProvider === "outlook_calendar" ? workspace.outlook : workspace.google || workspace.outlook;

  return {
    googleConfigured: getOAuthAppCredentials("google_calendar") !== null,
    google: { connected: !!google, accountEmail: google?.accountEmail ?? null },
    leads: {
      activeCrmProviders: crmConnections.filter((c) => c.status === "active").map((c) => c.provider),
      hasCrmConnection: crmConnections.length > 0,
      leadCount: Number(leadCountRow.rows[0]?.n ?? 0),
    },
    website: { origins: org?.allowedOrigins ?? [], websiteUrl: settings.contact.website },
    calendar: { syncProvider, orgConnected, workspaceConnected, calendlyUrl: settings.calendar.calendlyUrl },
  };
}
