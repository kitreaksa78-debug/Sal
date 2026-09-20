import React, { useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, AlertCircle, Crown } from 'lucide-react';
import { activatePurchase } from '../lib/api';
import { getAccountEmail, getPlan, setPlan } from '../lib/usage';
import { getSignedInUser } from '../lib/auth';

interface ProActivateProps {
  /** Called after the plan changes so the rest of the app can refresh. */
  onPlanChange?: (plan: 'free' | 'pro') => void;
}

/**
 * Pro is granted to whoever paid. There are no accounts yet, so the buyer proves
 * the purchase with the email they used at checkout and the server confirms it
 * against LemonSqueezy before unlocking.
 */
export const ProActivate: React.FC<ProActivateProps> = ({ onPlanChange }) => {
  // Default to the Google account that signed in, so the buyer only confirms.
  const [email, setEmail] = useState(getAccountEmail() ?? getSignedInUser()?.email ?? '');
  const [state, setState] = useState<'idle' | 'checking' | 'granted' | 'notFound' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // Already unlocked on this device — nothing to verify.
  if (getPlan() === 'pro' && state !== 'checking') {
    return (
      <div className="bg-emerald-900/20 border border-emerald-500/30 rounded-2xl p-4 sm:p-6 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
        <div className="min-w-0">
          <h4 className="text-emerald-300 font-semibold flex items-center gap-2">
            <Crown className="w-4 h-4" /> Pro plan សកម្ម
          </h4>
          <p className="text-sm text-slate-400 mt-1">
            អ្នកមានសិទ្ធិប្រើវីដេអូឥតកំណត់ និងរយៈពេលដល់ 30 នាទី។
            {getAccountEmail() && (
              <>
                {' '}
                គណនី៖ <span className="text-slate-300">{getAccountEmail()}</span>
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) {
      setState('error');
      setMessage('សូមបញ្ចូល email ត្រឹមត្រូវ។');
      return;
    }

    setState('checking');
    setMessage('');
    try {
      const result = await activatePurchase(email);
      if (result.plan === 'pro') {
        setPlan('pro', result.email);
        setState('granted');
        onPlanChange?.('pro');
      } else {
        setState('notFound');
        setMessage(
          `រកឃើញការជាវ ប៉ុន្តែស្ថានភាពគឺ "${result.status}"។ សូមពិនិត្យវិក្កយបត្ររបស់អ្នក។`
        );
      }
    } catch (err) {
      setState('notFound');
      setMessage(
        err instanceof Error
          ? err.message
          : 'មិនអាចផ្ទៀងផ្ទាត់បានទេ។ សូមព្យាយាមម្តងទៀត។'
      );
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-[#0d1320] rounded-2xl border border-slate-800 p-4 sm:p-6"
    >
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
          <KeyRound className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <h4 className="text-white font-semibold">បានទិញរួចហើយ? បើក Pro</h4>
          <p className="text-sm text-slate-400 mt-1">
            បញ្ចូល email ដែលអ្នកបានបង់ប្រាក់ ដើម្បីផ្ទៀងផ្ទាត់ និងបើកសិទ្ធិ Pro នៅលើឧបករណ៍នេះ។
            ប្រើវាផងដែរពេលអ្នកផ្លាស់ទីឧបករណ៍ ឬជំនួស browser។
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 px-4 py-3 rounded-xl bg-slate-950/60 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 transition-colors"
        />
        <button
          type="submit"
          disabled={state === 'checking'}
          className="px-6 py-3 min-h-[48px] rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold hover:from-emerald-600 hover:to-teal-600 transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-60 disabled:cursor-wait inline-flex items-center justify-center gap-2"
        >
          {state === 'checking' ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> កំពុងផ្ទៀងផ្ទាត់
            </>
          ) : (
            'ផ្ទៀងផ្ទាត់'
          )}
        </button>
      </div>

      {state === 'granted' && (
        <p className="mt-3 text-sm text-emerald-400 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> ជោគជ័យ! Pro plan ត្រូវបានបើករួចហើយ។
        </p>
      )}

      {(state === 'notFound' || state === 'error') && message && (
        <p className="mt-3 text-sm text-amber-400 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{message}</span>
        </p>
      )}
    </form>
  );
};
