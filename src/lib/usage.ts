// Usage tracking + plan state for the free tier.
// Usage is per-device (localStorage); the Pro plan is verified by the server.

import type { Plan } from './api';

const STORAGE_KEY = 'khmerdub_usage';
const PLAN_KEY = 'khmerdub_plan';
const EMAIL_KEY = 'khmerdub_email';

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

export function getPlan(): Plan {
  return readLocal(PLAN_KEY) === 'pro' ? 'pro' : 'free';
}

export function isPro(): boolean {
  return getPlan() === 'pro';
}

/** Remember the verified plan and the email it belongs to. */
export function setPlan(plan: Plan, email?: string): void {
  writeLocal(PLAN_KEY, plan);
  if (email) writeLocal(EMAIL_KEY, email.trim().toLowerCase());
}

export function getAccountEmail(): string | null {
  return readLocal(EMAIL_KEY);
}

export function clearPlan(): void {
  try {
    localStorage.removeItem(PLAN_KEY);
    localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* ignore */
  }
}

export function getTodayUsage(): UsageData {
  const stored = readLocal(STORAGE_KEY);

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
  writeLocal(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

export function canUseFreePlan(): { allowed: boolean; reason?: string } {
  if (isPro()) return { allowed: true };

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
  const limit = isPro() ? PRO_MAX_DURATION : FREE_MAX_DURATION;
  const limitLabel = isPro() ? '30 នាទី' : '2 នាទី';

  if (durationSeconds > limit) {
    return {
      allowed: false,
      reason: isPro()
        ? `វីដេអូរបស់អ្នក ${Math.round(durationSeconds)} វិនាទី។ Pro plan កំណត់ត្រឹម ${limitLabel}។`
        : `វីដេអូរបស់អ្នក ${Math.round(durationSeconds)} វិនាទី។ Free plan កំណត់ត្រឹម ${limitLabel}។ Upgrade to Pro សម្រាប់វីដេអូរហូតដល់ 30 នាទី។`,
    };
  }

  return { allowed: true };
}

export function recordUsage(durationSeconds: number): void {
  const usage = getTodayUsage();
  usage.count += 1;
  usage.totalDuration += durationSeconds;
  writeLocal(STORAGE_KEY, JSON.stringify(usage));
}

export function getUsageStats(): {
  used: number;
  limit: number;
  remaining: number;
  plan: Plan;
  unlimited: boolean;
} {
  const plan = getPlan();
  const usage = getTodayUsage();

  if (plan === 'pro') {
    return { used: usage.count, limit: Infinity, remaining: Infinity, plan, unlimited: true };
  }

  return {
    used: usage.count,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - usage.count),
    plan,
    unlimited: false,
  };
}
