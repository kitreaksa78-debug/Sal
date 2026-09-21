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

export async function isAppOwner(session: SessionRecord): Promise<boolean> {
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
