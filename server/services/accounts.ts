import { getDatabase } from './db.js';
import { SessionRecord, UserRecord } from '../types.js';

/**
 * Who owns the app itself.
 *
 * `OWNER_EMAILS` (comma separated) wins when it is set; otherwise the account
 * that signed up first is treated as the owner. Only that account may read the
 * full user list, and it is the one that keeps the videos uploaded before
 * accounts existed.
 */
export function getOwnerAllowlist(): string[] {
  return (process.env.OWNER_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an address is on the admin list without touching the database.
 *
 * `OWNER_EMAILS` is the authority: when it names someone, that answer is final
 * and does not depend on who signed up first (or on which accounts survived a
 * restart). Only the oldest-account fallback needs to read the user list, so
 * this stays a cheap check that routes can call on every request.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getOwnerAllowlist().includes(email.trim().toLowerCase());
}

export async function isAppOwner(session: SessionRecord): Promise<boolean> {
  if (isAdminEmail(session.email)) return true;
  const allowlist = getOwnerAllowlist();
  if (allowlist.length > 0) {
    return allowlist.includes(session.email.trim().toLowerCase());
  }

  const users = await getDatabase().listUsers(1000);
  const oldest = users.reduce<UserRecord | null>(
    (acc, user) =>
      !acc || new Date(user.createdAt).getTime() < new Date(acc.createdAt).getTime() ? user : acc,
    null
  );
  return oldest?.email === session.email;
}
