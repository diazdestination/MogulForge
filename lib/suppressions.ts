import "server-only";
import { getPool } from "./db";
import { normalizeEmail, normalizePhone } from "./rescue-import/normalize.ts";
import { suppressLeadContact } from "./rescue-engage/store.ts";

/**
 * Org suppression list management. Suppression records block contacts at
 * import time and campaign sends; adding one manually also suppresses any
 * existing matching leads immediately so the list is never cosmetic.
 */

export type SuppressionRecord = {
  id: string;
  channel: "email" | "phone";
  value: string;
  reason: string | null;
  source: string | null;
  createdAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRecord(row: any): SuppressionRecord {
  return { id: row.id, channel: row.channel, value: row.value, reason: row.reason, source: row.source, createdAt: row.created_at };
}

export async function listSuppressionRecords(organizationId: string, limit = 500): Promise<SuppressionRecord[]> {
  const { rows } = await getPool().query(
    "SELECT * FROM suppression_records WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2",
    [organizationId, Math.min(limit, 2000)],
  );
  return rows.map(mapRecord);
}

export type AddSuppressionResult =
  | { ok: true; record: SuppressionRecord; alreadyListed: boolean; leadsSuppressed: number }
  | { ok: false; error: string };

/**
 * Adds a manual suppression entry. The raw value is normalized exactly like
 * import/sending does, so the record actually matches future contacts; any
 * existing non-suppressed leads with the same contact are suppressed too.
 */
export async function addSuppressionRecord(
  organizationId: string,
  input: { channel: "email" | "phone"; value: string; note?: string | null },
): Promise<AddSuppressionResult> {
  const normalized = input.channel === "email" ? normalizeEmail(input.value) : normalizePhone(input.value);
  if (!normalized) {
    return {
      ok: false,
      error: input.channel === "email" ? "Enter a valid email address." : "Enter a valid US/Canada phone number.",
    };
  }
  const pool = getPool();
  const source = (input.note ?? "").trim().slice(0, 200) || "settings";
  const inserted = await pool.query(
    `INSERT INTO suppression_records (organization_id, channel, value, reason, source)
     VALUES ($1, $2, $3, 'manual', $4)
     ON CONFLICT (organization_id, channel, value) DO NOTHING RETURNING *`,
    [organizationId, input.channel, normalized, source],
  );
  const alreadyListed = inserted.rows.length === 0;
  const row = inserted.rows[0]
    ?? (await pool.query(
      "SELECT * FROM suppression_records WHERE organization_id = $1 AND channel = $2 AND value = $3",
      [organizationId, input.channel, normalized],
    )).rows[0];

  // Suppress matching leads that are not already suppressed.
  const column = input.channel === "email" ? "email_normalized" : "phone_normalized";
  const { rows: leads } = await pool.query(
    `SELECT id FROM rescue_leads WHERE organization_id = $1 AND ${column} = $2 AND suppressed = false`,
    [organizationId, normalized],
  );
  for (const lead of leads) {
    await suppressLeadContact(organizationId, lead.id, "Added to suppression list from settings", { optOut: false });
  }
  return { ok: true, record: mapRecord(row), alreadyListed, leadsSuppressed: leads.length };
}

/**
 * Removes a suppression record. Deliberately does NOT un-suppress leads that
 * were already flagged — un-suppression of a contact is not offered anywhere.
 */
export async function removeSuppressionRecord(organizationId: string, recordId: string): Promise<SuppressionRecord | null> {
  const { rows } = await getPool().query(
    "DELETE FROM suppression_records WHERE organization_id = $1 AND id = $2 RETURNING *",
    [organizationId, recordId],
  );
  return rows[0] ? mapRecord(rows[0]) : null;
}
