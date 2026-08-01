import "server-only";
import { randomBytes } from "node:crypto";
import { getPool } from "./db";
import { FEATURE_KEYS, type FeatureKey } from "./entitlements";
import type { OrgStatus, Plan, UsageLimits } from "./plans";
import { logAudit } from "./audit";

export type ProvisionInput = {
  name: string;
  slug?: string;
  industry?: string | null;
  timezone?: string;
  plan: Plan;
  status?: OrgStatus;
  modules: FeatureKey[];
  usageLimits: Partial<UsageLimits>;
  brandPrimaryColor?: string | null;
  brandSecondaryColor?: string | null;
  logoUrl?: string | null;
  allowedOrigins: string[];
  owner: { email: string; name?: string | null };
};

export type ProvisionResult = {
  organizationId: string;
  slug: string;
  inviteToken: string;
};

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Provisions a client organization end-to-end in one transaction: the org record,
 * an entitlement row for every feature key (enabled per selected modules), and the
 * initial owner invite. Audit-logged.
 */
export async function provisionOrganization(input: ProvisionInput, actor: { userId?: string | null; label: string }): Promise<ProvisionResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let slug = input.slug ? slugify(input.slug) : slugify(input.name);
    if (!slug) slug = `org-${randomBytes(4).toString("hex")}`;
    const existing = await client.query("SELECT 1 FROM organizations WHERE slug = $1", [slug]);
    if ((existing.rowCount ?? 0) > 0) slug = `${slug}-${randomBytes(3).toString("hex")}`;

    const orgResult = await client.query(
      `INSERT INTO organizations (name, slug, industry, timezone, plan, status, brand_primary_color, brand_secondary_color, logo_url, allowed_origins, usage_limits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        input.name,
        slug,
        input.industry ?? null,
        input.timezone ?? "America/New_York",
        input.plan,
        input.status ?? "active",
        input.brandPrimaryColor ?? null,
        input.brandSecondaryColor ?? null,
        input.logoUrl ?? null,
        input.allowedOrigins,
        JSON.stringify(input.usageLimits ?? {}),
      ],
    );
    const organizationId: string = orgResult.rows[0].id;

    for (const featureKey of FEATURE_KEYS) {
      await client.query(
        "INSERT INTO entitlements (organization_id, feature_key, enabled) VALUES ($1, $2, $3)",
        [organizationId, featureKey, input.modules.includes(featureKey)],
      );
    }

    const inviteToken = randomBytes(24).toString("base64url");
    await client.query(
      `INSERT INTO org_invites (token, organization_id, email, name, role, expires_at)
       VALUES ($1, $2, $3, $4, 'owner', now() + interval '14 days')`,
      [inviteToken, organizationId, input.owner.email.toLowerCase(), input.owner.name ?? null],
    );

    await client.query("COMMIT");

    await logAudit({
      organizationId,
      actorUserId: actor.userId ?? null,
      actorLabel: actor.label,
      action: "org.created",
      targetType: "organization",
      targetId: organizationId,
      metadata: { name: input.name, slug, plan: input.plan, modules: input.modules },
    });
    await logAudit({
      organizationId,
      actorUserId: actor.userId ?? null,
      actorLabel: actor.label,
      action: "member.invited",
      targetType: "invite",
      targetId: input.owner.email.toLowerCase(),
      metadata: { role: "owner" },
    });

    return { organizationId, slug, inviteToken };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
