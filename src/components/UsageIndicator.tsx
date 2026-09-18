import React, { useState, useEffect } from 'react';
import { BarChart3, Zap } from 'lucide-react';
import { getUsageStats } from '../lib/usage';
import { CheckoutButton } from './CheckoutButton';

export const UsageIndicator: React.FC = () => {
  const [stats, setStats] = useState(getUsageStats());
  
  useEffect(() => {
    // Refresh stats every minute
    const interval = setInterval(() => {
      setStats(getUsageStats());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const percentage = Math.round((stats.used / stats.limit) * 100);
  const isLow = stats.remaining <= 1;
  const isAtLimit = stats.remaining === 0;

  return (
    <div className={`flex items-center justify-between p-3 rounded-lg border ${
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
        <CheckoutButton variant="secondary" className="text-xs py-1.5 px-3" />
      )}
    </div>
  );
};
