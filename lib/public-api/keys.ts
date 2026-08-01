import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getPool } from "../db";
import { logAudit } from "../audit";
import { isApiScope, type ApiScope } from "./scopes";

/**
 * Scoped API keys for the public /api/v1 surface. The full key is returned exactly
 * once at creation/rotation; only a SHA-256 hash and a display prefix are stored.
 * Key format: rrk_<8 char id>_<40 char secret>
 */

export type ApiKeyRecord = {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFrom: string | null;
  createdAt: string;
};

const COLUMNS = `id, organization_id, name, prefix, scopes, status, last_used_at, revoked_at, rotated_from, created_at`;

function mapRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    prefix: String(row.prefix),
    scopes: ((row.scopes as string[]) ?? []).filter(isApiScope),
    status: row.status === "revoked" ? "revoked" : "active",
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
    rotatedFrom: row.rotated_from ? String(row.rotated_from) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export function hashApiKey(rawKey: string) {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey() {
  const shortId = randomBytes(6).toString("base64url").replace(/[-_]/g, "a").slice(0, 8);
  const secret = randomBytes(30).toString("base64url");
  const rawKey = `rrk_${shortId}_${secret}`;
  return { rawKey, prefix: `rrk_${shortId}`, keyHash: hashApiKey(rawKey) };
}

export async function createApiKey(
  organizationId: string,
  input: { name: string; scopes: ApiScope[]; createdBy?: string | null; rotatedFrom?: string | null },
): Promise<{ key: ApiKeyRecord; rawKey: string }> {
  const { rawKey, prefix, keyHash } = generateApiKey();
  const { rows } = await getPool().query(
    `INSERT INTO api_keys (organization_id, name, prefix, key_hash, scopes, created_by, rotated_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
    [organizationId, input.name, prefix, keyHash, input.scopes, input.createdBy ?? null, input.rotatedFrom ?? null],
  );
  return { key: mapRow(rows[0]), rawKey };
}

export async function listApiKeys(organizationId: string): Promise<ApiKeyRecord[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
    [organizationId],
  );
  return rows.map(mapRow);
}

export async function getApiKey(organizationId: string, keyId: string): Promise<ApiKeyRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM api_keys WHERE organization_id = $1 AND id = $2`,
    [organizationId, keyId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function revokeApiKey(organizationId: string, keyId: string, actor: { userId?: string | null; label: string }) {
  const { rows } = await getPool().query(
    `UPDATE api_keys SET status = 'revoked', revoked_at = now()
     WHERE organization_id = $1 AND id = $2 AND status = 'active' RETURNING ${COLUMNS}`,
    [organizationId, keyId],
  );
  if (!rows[0]) return null;
  await logAudit({
    organizationId,
    actorUserId: actor.userId ?? null,
    actorLabel: actor.label,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: keyId,
  });
  return mapRow(rows[0]);
}

/** Rotation revokes the old key and issues a replacement with the same name + scopes. */
export async function rotateApiKey(organizationId: string, keyId: string, actor: { userId?: string | null; label: string }) {
  const existing = await getApiKey(organizationId, keyId);
  if (!existing || existing.status !== "active") return null;
  await revokeApiKey(organizationId, keyId, actor);
  const created = await createApiKey(organizationId, {
    name: existing.name,
    scopes: existing.scopes,
    createdBy: actor.userId ?? null,
    rotatedFrom: keyId,
  });
  await logAudit({
    organizationId,
    actorUserId: actor.userId ?? null,
    actorLabel: actor.label,
    action: "api_key.rotated",
    targetType: "api_key",
    targetId: created.key.id,
    metadata: { rotatedFrom: keyId },
  });
  return created;
}

export type VerifiedApiKey = {
  keyId: string;
  organizationId: string;
  scopes: ApiScope[];
};

/** Looks up an active key by hash. Constant-time by construction (hash lookup). */
export async function verifyApiKey(rawKey: string): Promise<VerifiedApiKey | null> {
  if (!rawKey.startsWith("rrk_") || rawKey.length < 20 || rawKey.length > 200) return null;
  const { rows } = await getPool().query(
    `SELECT id, organization_id, scopes FROM api_keys WHERE key_hash = $1 AND status = 'active'`,
    [hashApiKey(rawKey)],
  );
  if (!rows[0]) return null;
  return {
    keyId: String(rows[0].id),
    organizationId: String(rows[0].organization_id),
    scopes: ((rows[0].scopes as string[]) ?? []).filter(isApiScope),
  };
}

/** Best-effort last-used bump; never blocks or fails a request. */
export function touchApiKey(keyId: string) {
  getPool()
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`, [keyId])
    .catch(() => {});
}
