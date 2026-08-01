import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getPool } from "./db";
import type { PlatformRole } from "./roles";

const COOKIE = "mf_session";
const MAX_AGE = 60 * 60 * 24 * 14; // 14 days

function secret() {
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  return process.env.SESSION_SECRET;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export async function createUserSession(userId: string) {
  const payload = `u.${userId}.${Date.now() + MAX_AGE * 1000}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function destroyUserSession() {
  (await cookies()).delete(COOKIE);
}

/** Returns the user id from a valid, unexpired, correctly signed session cookie — or null. */
export async function getSessionUserId(): Promise<string | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [scope, userId, expiry, signature] = parts;
  const payload = `${scope}.${userId}.${expiry}`;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (scope !== "u" || Number(expiry) <= Date.now()) return null;
  return userId;
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  platformRole: PlatformRole | null;
};

/** Loads the current user from the session cookie. Never trusts client-supplied ids. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const { rows } = await getPool().query(
    "SELECT id, email, name, platform_role FROM users WHERE id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, platformRole: row.platform_role ?? null };
}
