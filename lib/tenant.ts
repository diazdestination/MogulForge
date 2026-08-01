import "server-only";
import { randomBytes } from "node:crypto";
import { getPool } from "./db";
import type { FeatureKey } from "./entitlements";
import type { OrgRole } from "./roles";
import type { OrgStatus, Plan, UsageLimits } from "./plans";

/**
 * Typed tenant query layer. Every tenant-owned read/write REQUIRES an organizationId
 * parameter and scopes the SQL by it — callers can never accidentally query across tenants.
 */

export type Organization = {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  timezone: string;
  plan: Plan;
  status: OrgStatus;
  brandPrimaryColor: string | null;
  brandSecondaryColor: string | null;
  logoUrl: string | null;
  allowedOrigins: string[];
  usageLimits: Partial<UsageLimits> & Record<string, number>;
  brandingLevel: string;
  displayName: string | null;
  portalTitle: string | null;
  loginTitle: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  emailSenderName: string | null;
  smsSenderName: string | null;
  poweredByLabel: string | null;
  createdAt: string;
};

export type Member = {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  createdAt: string;
};

export type Entitlement = {
  featureKey: FeatureKey;
  enabled: boolean;
  limits: Record<string, number>;
};

export type Invite = {
  id: string;
  token: string;
  email: string;
  name: string | null;
  role: OrgRole;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapOrg(row: any): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    industry: row.industry,
    timezone: row.timezone,
    plan: row.plan,
    status: row.status,
    brandPrimaryColor: row.brand_primary_color,
    brandSecondaryColor: row.brand_secondary_color,
    logoUrl: row.logo_url,
    allowedOrigins: row.allowed_origins ?? [],
    usageLimits: row.usage_limits ?? {},
    brandingLevel: row.branding_level ?? "mogulforge",
    displayName: row.display_name ?? null,
    portalTitle: row.portal_title ?? null,
    loginTitle: row.login_title ?? null,
    supportEmail: row.support_email ?? null,
    supportPhone: row.support_phone ?? null,
    emailSenderName: row.email_sender_name ?? null,
    smsSenderName: row.sms_sender_name ?? null,
    poweredByLabel: row.powered_by_label ?? null,
    createdAt: row.created_at,
  };
}

export async function getOrganizationById(organizationId: string): Promise<Organization | null> {
  const { rows } = await getPool().query("SELECT * FROM organizations WHERE id = $1", [organizationId]);
  return rows[0] ? mapOrg(rows[0]) : null;
}

export async function listOrganizations(): Promise<(Organization & { memberCount: number })[]> {
  const { rows } = await getPool().query(
    `SELECT o.*, (SELECT count(*)::int FROM memberships m WHERE m.organization_id = o.id) AS member_count
     FROM organizations o ORDER BY o.created_at DESC`,
  );
  return rows.map((row) => ({ ...mapOrg(row), memberCount: row.member_count }));
}

export async function updateOrganization(
  organizationId: string,
  patch: Partial<Pick<Organization, "name" | "industry" | "timezone" | "plan" | "status" | "brandPrimaryColor" | "brandSecondaryColor" | "logoUrl" | "allowedOrigins" | "usageLimits" | "brandingLevel" | "displayName" | "portalTitle" | "loginTitle" | "supportEmail" | "supportPhone" | "emailSenderName" | "smsSenderName" | "poweredByLabel">>,
): Promise<Organization | null> {
  const columns: Record<string, unknown> = {};
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.industry !== undefined) columns.industry = patch.industry;
  if (patch.timezone !== undefined) columns.timezone = patch.timezone;
  if (patch.plan !== undefined) columns.plan = patch.plan;
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.brandPrimaryColor !== undefined) columns.brand_primary_color = patch.brandPrimaryColor;
  if (patch.brandSecondaryColor !== undefined) columns.brand_secondary_color = patch.brandSecondaryColor;
  if (patch.logoUrl !== undefined) columns.logo_url = patch.logoUrl;
  if (patch.allowedOrigins !== undefined) columns.allowed_origins = patch.allowedOrigins;
  if (patch.usageLimits !== undefined) columns.usage_limits = JSON.stringify(patch.usageLimits);
  if (patch.brandingLevel !== undefined) columns.branding_level = patch.brandingLevel;
  if (patch.displayName !== undefined) columns.display_name = patch.displayName;
  if (patch.portalTitle !== undefined) columns.portal_title = patch.portalTitle;
  if (patch.loginTitle !== undefined) columns.login_title = patch.loginTitle;
  if (patch.supportEmail !== undefined) columns.support_email = patch.supportEmail;
  if (patch.supportPhone !== undefined) columns.support_phone = patch.supportPhone;
  if (patch.emailSenderName !== undefined) columns.email_sender_name = patch.emailSenderName;
  if (patch.smsSenderName !== undefined) columns.sms_sender_name = patch.smsSenderName;
  if (patch.poweredByLabel !== undefined) columns.powered_by_label = patch.poweredByLabel;
  const keys = Object.keys(columns);
  if (keys.length === 0) return getOrganizationById(organizationId);
  const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
  const { rows } = await getPool().query(
    `UPDATE organizations SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
    [organizationId, ...keys.map((key) => columns[key])],
  );
  return rows[0] ? mapOrg(rows[0]) : null;
}

export async function getMembership(organizationId: string, userId: string): Promise<{ membershipId: string; role: OrgRole } | null> {
  const { rows } = await getPool().query(
    "SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2",
    [organizationId, userId],
  );
  return rows[0] ? { membershipId: rows[0].id, role: rows[0].role } : null;
}

export async function listMembers(organizationId: string): Promise<Member[]> {
  const { rows } = await getPool().query(
    `SELECT m.id AS membership_id, m.role, m.created_at, u.id AS user_id, u.email, u.name
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 ORDER BY m.created_at ASC`,
    [organizationId],
  );
  return rows.map((row) => ({
    membershipId: row.membership_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
  }));
}

export async function getMemberByMembershipId(organizationId: string, membershipId: string): Promise<Member | null> {
  const { rows } = await getPool().query(
    `SELECT m.id AS membership_id, m.role, m.created_at, u.id AS user_id, u.email, u.name
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.id = $2`,
    [organizationId, membershipId],
  );
  const row = rows[0];
  if (!row) return null;
  return { membershipId: row.membership_id, userId: row.user_id, email: row.email, name: row.name, role: row.role, createdAt: row.created_at };
}

export async function addMembership(organizationId: string, userId: string, role: OrgRole) {
  const { rows } = await getPool().query(
    `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING id`,
    [organizationId, userId, role],
  );
  return rows[0].id as string;
}

export async function updateMemberRole(organizationId: string, membershipId: string, role: OrgRole): Promise<boolean> {
  const { rowCount } = await getPool().query(
    "UPDATE memberships SET role = $3 WHERE organization_id = $1 AND id = $2",
    [organizationId, membershipId, role],
  );
  return (rowCount ?? 0) > 0;
}

export async function removeMember(organizationId: string, membershipId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    "DELETE FROM memberships WHERE organization_id = $1 AND id = $2",
    [organizationId, membershipId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listEntitlements(organizationId: string): Promise<Entitlement[]> {
  const { rows } = await getPool().query(
    "SELECT feature_key, enabled, limits FROM entitlements WHERE organization_id = $1 ORDER BY feature_key",
    [organizationId],
  );
  return rows.map((row) => ({ featureKey: row.feature_key, enabled: row.enabled, limits: row.limits ?? {} }));
}

export async function getEntitlement(organizationId: string, featureKey: FeatureKey): Promise<Entitlement | null> {
  const { rows } = await getPool().query(
    "SELECT feature_key, enabled, limits FROM entitlements WHERE organization_id = $1 AND feature_key = $2",
    [organizationId, featureKey],
  );
  const row = rows[0];
  return row ? { featureKey: row.feature_key, enabled: row.enabled, limits: row.limits ?? {} } : null;
}

export async function setEntitlement(organizationId: string, featureKey: FeatureKey, enabled: boolean) {
  await getPool().query(
    `INSERT INTO entitlements (organization_id, feature_key, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [organizationId, featureKey, enabled],
  );
}

export async function createInvite(organizationId: string, input: { email: string; name?: string | null; role: OrgRole }): Promise<Invite> {
  const token = randomBytes(24).toString("base64url");
  const { rows } = await getPool().query(
    `INSERT INTO org_invites (token, organization_id, email, name, role, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '14 days') RETURNING *`,
    [token, organizationId, input.email.toLowerCase(), input.name ?? null, input.role],
  );
  const row = rows[0];
  return { id: row.id, token: row.token, email: row.email, name: row.name, role: row.role, expiresAt: row.expires_at, acceptedAt: row.accepted_at, createdAt: row.created_at };
}

export async function listInvites(organizationId: string): Promise<Invite[]> {
  const { rows } = await getPool().query(
    "SELECT * FROM org_invites WHERE organization_id = $1 ORDER BY created_at DESC",
    [organizationId],
  );
  return rows.map((row) => ({ id: row.id, token: row.token, email: row.email, name: row.name, role: row.role, expiresAt: row.expires_at, acceptedAt: row.accepted_at, createdAt: row.created_at }));
}

export async function getInviteByToken(token: string): Promise<(Invite & { organizationId: string; organizationName: string }) | null> {
  const { rows } = await getPool().query(
    `SELECT i.*, o.name AS organization_name FROM org_invites i JOIN organizations o ON o.id = i.organization_id WHERE i.token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    email: row.email,
    name: row.name,
    role: row.role,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
  };
}

/** An invite is active when it has not been accepted and has not expired. */
export function isInviteActive(invite: Pick<Invite, "acceptedAt" | "expiresAt">) {
  return !invite.acceptedAt && new Date(invite.expiresAt).getTime() > Date.now();
}

export async function markInviteAccepted(inviteId: string) {
  await getPool().query("UPDATE org_invites SET accepted_at = now() WHERE id = $1", [inviteId]);
}

/** Revokes a pending invite. Accepted invites are history and cannot be revoked. */
export async function revokeInvite(organizationId: string, inviteId: string): Promise<Invite | null> {
  const { rows } = await getPool().query(
    "DELETE FROM org_invites WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL RETURNING *",
    [organizationId, inviteId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, token: row.token, email: row.email, name: row.name, role: row.role, expiresAt: row.expires_at, acceptedAt: row.accepted_at, createdAt: row.created_at };
}
