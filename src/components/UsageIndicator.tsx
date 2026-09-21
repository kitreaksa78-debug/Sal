import React, { useState, useEffect } from 'react';
import { BarChart3, Crown, Zap } from 'lucide-react';
import { getUsageStats } from '../lib/usage';
import { CheckoutButton } from './CheckoutButton';

interface UsageIndicatorProps {
  /**
   * The app's server-synced numbers for the signed-in account. Without them the
   * panel falls back to this device's mirror, refreshed every minute.
   */
  stats?: ReturnType<typeof getUsageStats>;
}

export const UsageIndicator: React.FC<UsageIndicatorProps> = ({ stats: provided }) => {
  const [mirror, setMirror] = useState(getUsageStats());

  useEffect(() => {
    if (provided) return;
    const interval = setInterval(() => {
      setMirror(getUsageStats());
    }, 60000);
    return () => clearInterval(interval);
  }, [provided]);

  const stats = provided ?? mirror;

  if (stats.unlimited) {
    return (
      <div className="flex items-center justify-between p-3 rounded-lg border bg-emerald-900/20 border-emerald-500/30">
        <div className="flex items-center gap-3">
          <Crown className="w-4 h-4 text-emerald-400" />
          <div>
            <div className="text-sm font-medium text-emerald-300">Pro plan — វីដេអូឥតកំណត់</div>
            <div className="text-[11px] text-slate-400">
              {stats.used} វីដេអូដំណើរការរួច · រយៈពេលដល់ 30 នាទីក្នុងមួយវីដេអូ
            </div>
          </div>
        </div>
      </div>
    );
  }

  const percentage = Math.round((stats.used / stats.limit) * 100);
  const isLow = stats.remaining <= 1;
  const isAtLimit = stats.remaining === 0;

  return (
    <div className={`flex flex-col sm:flex-row sm:items-center gap-3 justify-between p-3 rounded-lg border ${
      isAtLimit
        ? 'bg-red-900/20 border-red-500/30'
        : isLow
          ? 'bg-amber-900/20 border-amber-500/30'
          : 'bg-slate-800/50 border-slate-700/50'
    }`}>
      <div className="flex items-center gap-3">
        <BarChart3 className={`w-4 h-4 ${
          isAtLimit ? 'text-red-400' : isLow ? 'text-amber-400' : 'text-slate-400'
        }`} />
        <div>
          <div className="text-sm font-medium text-slate-300">
            Free plan: {stats.used}/{stats.limit} វីដេអូ/ថ្ងៃ
          </div>
          <div className="w-32 h-1.5 bg-slate-700 rounded-full mt-1 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                isAtLimit ? 'bg-red-500' : isLow ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, percentage)}%` }}
            />
          </div>
        </div>
      </div>

      {isLow && (
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-emerald-400" />
          <CheckoutButton variant="secondary" className="[&_button]:text-xs [&_button]:py-1.5 [&_button]:px-3" />
        </div>
      )}
    </div>
  );
};
