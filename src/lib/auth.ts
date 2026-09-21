// The signed-in Google account, remembered on this device together with the
// session token the server issued for it.
//
// The server is the source of truth: it verifies every sign-in with Google and
// keeps each account's videos, history and daily usage under its own id. The
// token is what proves which account a request belongs to.

import type { SignedInUser } from './api';

const SESSION_KEY = 'khmerdub_session';
/** Sign-ins from before sessions existed; a fresh token is minted on re-login. */
const LEGACY_KEY = 'khmerdub_user';

export interface StoredSession {
  user: SignedInUser;
  token: string;
}

export function getSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.user?.id || !parsed?.user?.email || !parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getSignedInUser(): SignedInUser | null {
  return getSession()?.user ?? null;
}

/** Empty string when nobody is signed in — callers treat that as "no account". */
export function getAuthToken(): string {
  return getSession()?.token ?? '';
}

export function saveSession(user: SignedInUser, token: string): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, token }));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* private browsing / storage disabled */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

/** The account this device is signed in as, for display next to their own data. */
export function sessionLabel(): string {
  return getSignedInUser()?.email ?? '';
}
