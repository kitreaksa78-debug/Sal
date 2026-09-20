// The signed-in Google account, remembered on this device. The server is the
// source of truth: it verifies every sign-in with Google and stores the account.

import type { SignedInUser } from './api';

const USER_KEY = 'khmerdub_user';

export function getSignedInUser(): SignedInUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as SignedInUser;
    return parsed?.email && parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSignedInUser(user: SignedInUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* private browsing / storage disabled */
  }
}

export function clearSignedInUser(): void {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}
