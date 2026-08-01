import "server-only";
import { randomBytes } from "node:crypto";
import { getPool } from "./db";
import { FEATURE_KEYS } from "./entitlements";
import { PLAN_DEFAULTS } from "./plans";
import { slugify } from "./provisioning";
import { logAudit } from "./audit";
import { MANAGER_ROLES, type OrgRole } from "./roles";
import type { RescueIntakeInput } from "./rescue-intake-schema";

/**
 * Self-serve intake: resolves the organization the wizard submission belongs to.
 * If the user already manages an org, that org is reused; otherwise a starter
 * org is provisioned with the user as owner (membership created directly — no
 * invite round-trip, unlike admin provisioning).
 */

export type IntakeOrgResult = { organizationId: string; created: boolean };

export async function resolveIntakeOrganization(
  user: { id: string; email: string; name: string },
  companyName: string,
  industry: string,
): Promise<IntakeOrgResult> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT m.organization_id, m.role FROM memberships m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND o.status = 'active'
     ORDER BY m.created_at ASC`,
    [user.id],
  );
  const managed = rows.find((row) => (MANAGER_ROLES as readonly OrgRole[]).includes(row.role));
  if (managed) return { organizationId: managed.organization_id, created: false };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let slug = slugify(companyName) || `org-${randomBytes(4).toString("hex")}`;
    const existing = await client.query("SELECT 1 FROM organizations WHERE slug = $1", [slug]);
    if ((existing.rowCount ?? 0) > 0) slug = `${slug}-${randomBytes(3).toString("hex")}`;

    const defaults = PLAN_DEFAULTS.starter;
    const orgResult = await client.query(
      `INSERT INTO organizations (name, slug, industry, plan, status, usage_limits)
       VALUES ($1, $2, $3, 'starter', 'active', $4) RETURNING id`,
      [companyName, slug, industry, JSON.stringify(defaults.limits)],
    );
    const organizationId: string = orgResult.rows[0].id;

    for (const featureKey of FEATURE_KEYS) {
      await client.query(
        "INSERT INTO entitlements (organization_id, feature_key, enabled) VALUES ($1, $2, $3)",
        [organizationId, featureKey, defaults.modules.includes(featureKey)],
      );
    }
    await client.query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
      [organizationId, user.id],
    );
    await client.query("COMMIT");

    await logAudit({
      organizationId,
      actorUserId: user.id,
      actorLabel: user.email,
      action: "org.self_serve_created",
      targetType: "organization",
      targetId: organizationId,
      metadata: { name: companyName, slug, plan: "starter", via: "revenue-rescue-intake" },
    });
    return { organizationId, created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recordIntake(
  organizationId: string,
  userId: string,
  intake: RescueIntakeInput,
): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO rescue_intakes (organization_id, created_by, company, lead_sources, campaign_preferences, confirmations)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      organizationId,
      userId,
      JSON.stringify(intake.company),
      JSON.stringify(intake.leadSources),
      JSON.stringify(intake.campaignPreferences),
      JSON.stringify(intake.confirmations),
    ],
  );
  return rows[0].id;
}
