import "server-only";
import { getPool } from "./db";
import { DEFAULT_ORG_SETTINGS, normalizeOrgSettings, type OrgSettings } from "./org-settings-schema.ts";

/** Tenant-scoped read/write for the organizations.settings jsonb blob. */

export async function getOrgSettings(organizationId: string): Promise<OrgSettings> {
  const { rows } = await getPool().query("SELECT settings FROM organizations WHERE id = $1", [organizationId]);
  return normalizeOrgSettings(rows[0]?.settings ?? {});
}

/**
 * Merges the submitted patch over the stored settings (section-wise, validated)
 * and persists the fully-normalized result. Returns the new settings.
 */
export async function updateOrgSettings(organizationId: string, patch: unknown): Promise<OrgSettings | null> {
  const pool = getPool();
  const { rows } = await pool.query("SELECT settings FROM organizations WHERE id = $1", [organizationId]);
  if (!rows[0]) return null;
  const current = normalizeOrgSettings(rows[0].settings ?? {}, DEFAULT_ORG_SETTINGS);
  const next = normalizeOrgSettings(patch, current);
  await pool.query("UPDATE organizations SET settings = $2, updated_at = now() WHERE id = $1", [
    organizationId,
    JSON.stringify(next),
  ]);
  return next;
}
