import React from 'react';
import { Check, Zap, Crown, Video } from 'lucide-react';
import { CheckoutButton } from './CheckoutButton';
import { getPlan, PRO_PRICE_USD } from '../lib/usage';

interface PricingPageProps {
  onSelectPlan?: (plan: 'free' | 'pro') => void;
}

/**
 * Pro unlocks automatically for the signed-in account, so this page only has to
 * offer the two plans and hand the Pro button to the checkout.
 */
export const PricingPage: React.FC<PricingPageProps> = ({ onSelectPlan }) => {
  const isPro = getPlan() === 'pro';

  return (
    <div className="max-w-5xl mx-auto py-6 sm:py-10">
      {/* Header */}
      <div className="text-center mb-8 sm:mb-12">
        <h2 className="text-2xl sm:text-4xl font-bold text-white mb-3">
          តម្លៃ <span className="text-emerald-400">សាមញ្ញ</span>
        </h2>
        <p className="text-sm sm:text-lg text-slate-400 max-w-2xl mx-auto">
          ចាប់ផ្តើមដោយឥតគិតថ្លៃ។ អភិវឌ្ឍន៍ជាមួយ Pro នៅពេលអ្នករួចរាល់។
        </p>
      </div>

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8 max-w-4xl mx-auto">
        {/* Free Plan */}
        <div className="relative bg-[#0d1320] rounded-2xl border border-slate-800 p-5 sm:p-8 hover:border-slate-700 transition-all duration-300 flex flex-col">
          <div className="mb-6">
            <div className="w-11 h-11 rounded-xl bg-slate-800 flex items-center justify-center mb-4">
              <Video className="w-5 h-5 text-slate-400" />
            </div>
            <h3 className="text-xl sm:text-2xl font-bold text-white">Free</h3>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-bold text-white">$0</span>
              <span className="text-slate-400 text-sm">/ខែ</span>
            </div>
          </div>

          <ul className="space-y-3.5 mb-8 flex-1">
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300 text-sm sm:text-base">
                <strong className="text-white">3 វីដេអូ</strong>/ថ្ងៃ
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300 text-sm sm:text-base">
                <strong className="text-white">2 នាទី</strong> ក្នុងមួយវីដេអូ
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300 text-sm sm:text-base">
                <strong className="text-white">720p</strong> output
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300 text-sm sm:text-base">អក្សររត់ខ្មែរ (Khmer subtitles)</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300 text-sm sm:text-base">AI translation</span>
            </li>
          </ul>

          <button
            type="button"
            onClick={() => onSelectPlan?.('free')}
            className="w-full min-h-[48px] py-3 px-6 rounded-xl border border-slate-700 text-white font-semibold hover:bg-slate-800 transition-colors"
          >
            {isPro ? 'បន្តប្រើប្រាស់' : 'ចាប់ផ្តើមឥតគិតថ្លៃ'}
          </button>
        </div>

        {/* Pro Plan */}
        <div className="relative bg-gradient-to-b from-emerald-900/20 to-[#0d1320] rounded-2xl border border-emerald-500/30 p-5 sm:p-8 pt-8 hover:border-emerald-500/50 transition-all duration-300 shadow-lg shadow-emerald-500/10 flex flex-col">
          {/* Popular Badge */}
          <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
            <span className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-xs sm:text-sm font-bold px-3.5 py-1.5 rounded-full shadow-lg whitespace-nowrap inline-flex items-center gap-1">
              <Crown className="w-3.5 h-3.5" />
              POPULAR
            </span>
          </div>

          <div className="mb-6">
            <div className="w-11 h-11 rounded-xl bg-emerald-500/20 flex items-center justify-center mb-4">
              <Zap className="w-5 h-5 text-emerald-400" />
            </div>
            <h3 className="text-xl sm:text-2xl font-bold text-white">Pro</h3>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-bold text-white">${PRO_PRICE_USD}</span>
              <span className="text-slate-400 text-sm">/ខែ</span>
            </div>
          </div>

          <ul className="space-y-3.5 mb-8 flex-1">
            {['វីដេអូឥតកំណត់', '30 នាទី ក្នុងមួយវីដេអូ', '1080p output', 'Priority processing', 'API access', 'No watermark'].map(
              (feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
                  <span className="text-slate-300 text-sm sm:text-base">{feature}</span>
                </li>
              )
            )}
          </ul>

          <CheckoutButton className="w-full" />
        </div>
      </div>
    </div>
  );
};
