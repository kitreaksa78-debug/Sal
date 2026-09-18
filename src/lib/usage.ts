// Usage tracking for free tier limits
// Stores usage in localStorage (client-side) + server-side validation

const STORAGE_KEY = 'khmerdub_usage';
const DAILY_LIMIT = 3; // Free plan: 3 videos/day
const MAX_DURATION = 120; // Free plan: 2 minutes (120 seconds)

interface UsageData {
  date: string; // YYYY-MM-DD
  count: number;
  totalDuration: number; // seconds
}

export function getTodayUsage(): UsageData {
  const today = new Date().toISOString().split('T')[0];
  const stored = localStorage.getItem(STORAGE_KEY);
  
  if (stored) {
    try {
      const data = JSON.parse(stored) as UsageData;
      if (data.date === today) {
        return data;
      }
    } catch {}
  }
  
  // Reset for new day
  const fresh: UsageData = { date: today, count: 0, totalDuration: 0 };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

export function canUseFreePlan(): { allowed: boolean; reason?: string } {
  const usage = getTodayUsage();
  
  if (usage.count >= DAILY_LIMIT) {
    return {
      allowed: false,
      reason: `អ្នកប្រើប្រាស់ ${DAILY_LIMIT} វីដេអូរួចហើយថ្ងៃនេះ។ សូមរង់ចាំថ្ងៃស្អែក ឬ Upgrade to Pro។`
    };
  }
  
  return { allowed: true };
}

export function canProcessVideo(durationSeconds: number): { allowed: boolean; reason?: string } {
  if (durationSeconds > MAX_DURATION) {
    return {
      allowed: false,
      reason: `វីដេអូរបស់អ្នក ${Math.round(durationSeconds)} វិនាទី។ Free plan កំណត់ត្រឹម ${MAX_DURATION} វិនាទី។ Upgrade to Pro សម្រាប់វីដេអូរហូតដល់ 30 នាទី។`
    };
  }
  
  return { allowed: true };
}

export function recordUsage(durationSeconds: number): void {
  const usage = getTodayUsage();
  usage.count += 1;
  usage.totalDuration += durationSeconds;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
}

export function getUsageStats(): { used: number; limit: number; remaining: number } {
  const usage = getTodayUsage();
  return {
    used: usage.count,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - usage.count),
  };
}
