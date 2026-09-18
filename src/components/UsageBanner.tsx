import React from 'react';
import { AlertTriangle, Zap, Crown } from 'lucide-react';
import { CheckoutButton } from './CheckoutButton';

interface UsageBannerProps {
  used: number;
  limit: number;
  reason?: string;
}

export const UsageBanner: React.FC<UsageBannerProps> = ({ used, limit, reason }) => {
  const remaining = Math.max(0, limit - used);
  const isAtLimit = remaining === 0;
  const isNearLimit = remaining <= 1 && !isAtLimit;

  if (!isAtLimit && !isNearLimit) return null;

  return (
    <div className={`rounded-xl border p-4 ${
      isAtLimit 
        ? 'bg-red-900/20 border-red-500/30' 
        : 'bg-amber-900/20 border-amber-500/30'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isAtLimit ? 'bg-red-500/20' : 'bg-amber-500/20'
        }`}>
          {isAtLimit ? (
            <AlertTriangle className="w-5 h-5 text-red-400" />
          ) : (
            <Crown className="w-5 h-5 text-amber-400" />
          )}
        </div>
        
        <div className="flex-1">
          <h4 className={`font-semibold ${
            isAtLimit ? 'text-red-300' : 'text-amber-300'
          }`}>
            {isAtLimit ? 'ដែនកំណត់ឥតគិតថ្លៃ' : 'ជិតដល់ដែនកំណត់'}
          </h4>
          
          <p className="text-sm text-slate-400 mt-1">
            {isAtLimit 
              ? (reason || `អ្នកប្រើប្រាស់ ${limit} វីដេអូរួចហើយថ្ងៃនេះ។`)
              : `នៅសល់ ${remaining} វីដេអូ/ថ្ងៃ។`
            }
          </p>
          
          <div className="mt-3">
            <CheckoutButton variant="secondary" className="text-sm" />
          </div>
        </div>
      </div>
    </div>
  );
};
