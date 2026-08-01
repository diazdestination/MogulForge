import { NextResponse } from "next/server";
import { guard, requireUser } from "@/lib/api-guard";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = guard(async () => {
  const user = await requireUser();
  const { rows } = await getPool().query(
    `SELECT m.organization_id, m.role, o.name FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 ORDER BY m.created_at ASC`,
    [user.id],
  );
  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, platformRole: user.platformRole },
    organizations: rows.map((row) => ({ organizationId: row.organization_id, name: row.name, role: row.role })),
  });
});
