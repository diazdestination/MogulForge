import "server-only";
import { getPool } from "./db";
import { getCurrentUser, type SessionUser } from "./auth";
import { getEntitlement } from "./tenant";
import type { FeatureKey } from "./entitlements";
import type { OrgRole } from "./roles";
import { recordActiveUserInBackground } from "./usage";

/**
 * Shared org resolution for dashboard pages. The ?org= param is only honored
 * when the signed-in user actually belongs to that organization — membership
 * rows decide access, never the URL.
 */

export type DashboardMembership = { id: string; name: string; role: OrgRole };

export type DashboardContext =
  | { kind: "unauthenticated" }
  | { kind: "no_org"; user: SessionUser }
  | { kind: "no_entitlement"; user: SessionUser; active: DashboardMembership; memberships: DashboardMembership[]; feature: FeatureKey }
  | { kind: "ok"; user: SessionUser; active: DashboardMembership; memberships: DashboardMembership[]; role: OrgRole };

export async function getDashboardContext(orgParam: string | undefined, feature: FeatureKey): Promise<DashboardContext> {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" };
  const { rows } = await getPool().query(
    `SELECT o.id, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND o.status = 'active' ORDER BY m.created_at ASC`,
    [user.id],
  );
  const memberships: DashboardMembership[] = rows.map((row) => ({ id: row.id, name: row.name, role: row.role }));
  if (memberships.length === 0) return { kind: "no_org", user };
  const active = memberships.find((m) => m.id === orgParam) ?? memberships[0];
  const entitlement = await getEntitlement(active.id, feature);
  if (!entitlement?.enabled) return { kind: "no_entitlement", user, active, memberships, feature };
  recordActiveUserInBackground(active.id, user.id); // usage metering: distinct active users per period
  return { kind: "ok", user, active, memberships, role: active.role };
}
