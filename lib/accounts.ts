import "server-only";
import { getPool } from "./db";
import { hashPassword, verifyPassword } from "./passwords";
import { logAudit } from "./audit";
import { addMembership, getInviteByToken, markInviteAccepted } from "./tenant";

export type AccountResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

export async function findUserByEmail(email: string) {
  const { rows } = await getPool().query(
    "SELECT id, email, name, password_hash, platform_role FROM users WHERE email = $1",
    [email.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function registerUser(input: { email: string; name: string; password: string }): Promise<AccountResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (name.length < 1) return { ok: false, error: "Enter your name." };
  if (input.password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  if (await findUserByEmail(email)) return { ok: false, error: "An account with that email already exists." };
  const { rows } = await getPool().query(
    "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
    [email, name, hashPassword(input.password)],
  );
  const userId: string = rows[0].id;
  await logAudit({ actorUserId: userId, actorLabel: email, action: "auth.register", targetType: "user", targetId: userId });
  return { ok: true, userId };
}

export async function authenticateUser(email: string, password: string): Promise<AccountResult> {
  const user = await findUserByEmail(email.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { ok: false, error: "Invalid email or password." };
  }
  await logAudit({ actorUserId: user.id, actorLabel: user.email, action: "auth.login", targetType: "user", targetId: user.id });
  return { ok: true, userId: user.id };
}

/**
 * Accepts an org invite. If no account exists for the invite email, one is created with
 * the supplied name/password. If an account exists, the password must match (sign-in).
 */
export async function acceptInvite(input: { token: string; name?: string; password: string }): Promise<AccountResult & { organizationId?: string }> {
  const invite = await getInviteByToken(input.token);
  if (!invite) return { ok: false, error: "This invite link is invalid." };
  if (invite.acceptedAt) return { ok: false, error: "This invite has already been used." };
  if (new Date(invite.expiresAt).getTime() < Date.now()) return { ok: false, error: "This invite has expired." };

  const existing = await findUserByEmail(invite.email);
  let userId: string;
  if (existing) {
    if (!verifyPassword(input.password, existing.password_hash)) {
      return { ok: false, error: "An account with this email already exists — enter its password to continue." };
    }
    userId = existing.id;
  } else {
    if (input.password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
    const name = (input.name ?? invite.name ?? "").trim() || invite.email.split("@")[0];
    const { rows } = await getPool().query(
      "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [invite.email, name, hashPassword(input.password)],
    );
    userId = rows[0].id;
    await logAudit({ actorUserId: userId, actorLabel: invite.email, action: "auth.register", targetType: "user", targetId: userId });
  }

  await addMembership(invite.organizationId, userId, invite.role);
  await markInviteAccepted(invite.id);
  await logAudit({
    organizationId: invite.organizationId,
    actorUserId: userId,
    actorLabel: invite.email,
    action: "invite.accepted",
    targetType: "membership",
    targetId: userId,
    metadata: { role: invite.role },
  });
  return { ok: true, userId, organizationId: invite.organizationId };
}
