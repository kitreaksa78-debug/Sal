// Usage tracking + plan state for the free tier.
//
// Every value here belongs to the signed-in account: the storage keys are scoped
// by Google account id, so signing in as somebody else on the same phone shows
// their own counter and their own plan. The server remains the referee — it bumps
// the daily count on every upload and `getUsage()` mirrors it back here.

import type { Plan, UsageSummary } from './api';
import { getSignedInUser } from './auth';

const USAGE_BASE = 'khmerdub_usage';
const PLAN_BASE = 'khmerdub_plan';
const EMAIL_BASE = 'khmerdub_email';
const ADMIN_BASE = 'khmerdub_admin';

/** Free plan: 3 videos/day, 2 minutes each. */
export const FREE_DAILY_LIMIT = 3;
export const FREE_MAX_DURATION = 120;
/** Pro plan: 30 minutes per video. */
export const PRO_MAX_DURATION = 1800;
export const PRO_PRICE_USD = '9.99';

interface UsageData {
  date: string; // YYYY-MM-DD
  count: number;
  totalDuration: number; // seconds
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** Keeps one account's numbers from ever showing up under another's name. */
function scoped(base: string): string {
  const id = getSignedInUser()?.id ?? 'guest';
  return `${base}:${id}`;
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing / storage disabled */
  }
}

function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getPlan(): Plan {
  return readLocal(scoped(PLAN_BASE)) === 'pro' ? 'pro' : 'free';
}

export function isPro(): boolean {
  return getPlan() === 'pro';
}

/**
 * An admin account: an address listed in the server's `OWNER_EMAILS`, or — when
 * that is unset — the account that signed up first.
 *
 * The server decides this — it reports the flag on every usage sync — and this
 * device only remembers the answer for the signed-in account. Admin is a
 * superset of Pro: no daily cap and no 2-minute limit on the owner's own app,
 * and it is what shows the stem-separation card in the studio.
 */
export function isAdmin(): boolean {
  return readLocal(scoped(ADMIN_BASE)) === 'true';
}

export function setAdmin(admin: boolean): void {
  if (admin) writeLocal(scoped(ADMIN_BASE), 'true');
  else removeLocal(scoped(ADMIN_BASE));
}

/** Pro or admin — both run without the free tier's caps. */
export function isUnlimited(): boolean {
  return isPro() || isAdmin();
}

/** Remember the verified plan for this account. */
export function setPlan(plan: Plan, email?: string): void {
  const account = email ?? getSignedInUser()?.email;
  writeLocal(scoped(PLAN_BASE), plan);
  if (account) writeLocal(scoped(EMAIL_BASE), account.trim().toLowerCase());
}

/** The email Pro purchases are verified against for this account. */
export function getAccountEmail(): string | null {
  return getSignedInUser()?.email ?? readLocal(scoped(EMAIL_BASE));
}

export function clearPlan(): void {
  removeLocal(scoped(PLAN_BASE));
  removeLocal(scoped(EMAIL_BASE));
  removeLocal(scoped(ADMIN_BASE));
}

export function getTodayUsage(): UsageData {
  const stored = readLocal(scoped(USAGE_BASE));

  if (stored) {
    try {
      const data = JSON.parse(stored) as UsageData;
      if (data.date === today()) {
        return data;
      }
    } catch {
      /* corrupt entry — start over */
    }
  }

  const fresh: UsageData = { date: today(), count: 0, totalDuration: 0 };
  writeLocal(scoped(USAGE_BASE), JSON.stringify(fresh));
  return fresh;
}

/**
 * Copy a count down from the server. The server is the one that actually counts,
 * so whatever it reports wins over this device's mirror.
 */
export function applyServerUsage(usage: UsageSummary): void {
  if (!usage || usage.date !== today()) return;
  const mirror: UsageData = {
    date: usage.date,
    count: usage.count,
    totalDuration: usage.totalDuration,
  };
  writeLocal(scoped(USAGE_BASE), JSON.stringify(mirror));
}

export function canUseFreePlan(): { allowed: boolean; reason?: string } {
  if (isUnlimited()) return { allowed: true };

  const usage = getTodayUsage();
  if (usage.count >= FREE_DAILY_LIMIT) {
    return {
      allowed: false,
      reason: `អ្នកប្រើប្រាស់ ${FREE_DAILY_LIMIT} វីដេអូរួចហើយថ្ងៃនេះ។ សូមរង់ចាំថ្ងៃស្អែក ឬ Upgrade to Pro។`,
    };
  }

  return { allowed: true };
}

export function canProcessVideo(durationSeconds: number): { allowed: boolean; reason?: string } {
  const unlimited = isUnlimited();
  const limit = unlimited ? PRO_MAX_DURATION : FREE_MAX_DURATION;
  const limitLabel = unlimited ? '30 នាទី' : '2 នាទី';

  if (durationSeconds > limit) {
    return {
      allowed: false,
      reason: unlimited
        ? `វីដេអូរបស់អ្នក ${Math.round(durationSeconds)} វិនាទី។ គណនីនេះកំណត់ត្រឹម ${limitLabel}។`
        : `វីដេអូរបស់អ្នក ${Math.round(durationSeconds)} វិនាទី។ Free plan កំណត់ត្រឹម ${limitLabel}។ Upgrade to Pro សម្រាប់វីដេអូរហូតដល់ 30 នាទី។`,
    };
  }

  return { allowed: true };
}

export function getUsageStats(): {
  used: number;
  limit: number;
  remaining: number;
  plan: Plan;
  admin: boolean;
  unlimited: boolean;
} {
  const plan = getPlan();
  const admin = isAdmin();
  const usage = getTodayUsage();

  if (admin || plan === 'pro') {
    return { used: usage.count, limit: Infinity, remaining: Infinity, plan, admin, unlimited: true };
  }

  return {
    used: usage.count,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - usage.count),
    plan,
    admin,
    unlimited: false,
  };
}
