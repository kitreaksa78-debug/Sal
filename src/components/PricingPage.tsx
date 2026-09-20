import React from 'react';
import { Check, Zap, Crown, Video, Clock, Download, Headphones } from 'lucide-react';
import { CheckoutButton } from './CheckoutButton';
import { ProActivate } from './ProActivate';
import { getPlan, PRO_PRICE_USD } from '../lib/usage';

interface PricingPageProps {
  onSelectPlan?: (plan: 'free' | 'pro') => void;
  onPlanChange?: (plan: 'free' | 'pro') => void;
}

interface ComparisonRow {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  free: string;
  pro: string;
}

const COMPARISON_ROWS: ComparisonRow[] = [
  { Icon: Video, label: 'វីដេអូ/ថ្ងៃ', free: '3', pro: 'ឥតកំណត់' },
  { Icon: Clock, label: 'រយៈពេលវីដេអូ', free: '2 នាទី', pro: '30 នាទី' },
  { Icon: Download, label: 'គុណភាពលទ្ធផល', free: '720p', pro: '1080p' },
  { Icon: Headphones, label: 'Khmer TTS', free: '✅', pro: '✅' },
  { Icon: Zap, label: 'អាទិភាពដំណើរការ', free: '—', pro: '✅' },
];

export const PricingPage: React.FC<PricingPageProps> = ({ onSelectPlan, onPlanChange }) => {
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

      {/* Restore a purchase / unlock on another device */}
      <div className="mt-8 sm:mt-10 max-w-4xl mx-auto">
        <ProActivate onPlanChange={onPlanChange} />
      </div>

      {/* Features Comparison */}
      <div className="mt-12 sm:mt-16 max-w-4xl mx-auto">
        <h3 className="text-xl sm:text-2xl font-bold text-white text-center mb-6 sm:mb-8">ការប្រៀបធៀប</h3>

        <div className="bg-[#0d1320] rounded-2xl border border-slate-800 overflow-hidden">
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[380px]">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left p-3 sm:p-4 text-xs sm:text-sm text-slate-400 font-medium">
                    លក្ខណៈ
                  </th>
                  <th className="text-center p-3 sm:p-4 text-xs sm:text-sm text-slate-400 font-medium">Free</th>
                  <th className="text-center p-3 sm:p-4 text-xs sm:text-sm text-emerald-400 font-medium">Pro</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map(({ Icon, label, free, pro }) => (
                  <tr key={label} className="border-b border-slate-800/50 last:border-0">
                    {/* NOTE: no `flex` on the <td> itself — that breaks the table row. */}
                    <td className="p-3 sm:p-4">
                      <div className="flex items-center gap-2 text-xs sm:text-sm text-slate-300">
                        <Icon className="w-4 h-4 text-slate-500 shrink-0" />
                        <span>{label}</span>
                      </div>
                    </td>
                    <td className="p-3 sm:p-4 text-center text-xs sm:text-sm text-slate-300">{free}</td>
                    <td className="p-3 sm:p-4 text-center text-xs sm:text-sm text-emerald-400 font-semibold">
                      {pro}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div className="mt-12 sm:mt-16 max-w-3xl mx-auto">
        <h3 className="text-xl sm:text-2xl font-bold text-white text-center mb-6 sm:mb-8">
          សំណួរដែលគេសួរញឹកញាប់
        </h3>

        <div className="space-y-4">
          <div className="bg-[#0d1320] rounded-xl border border-slate-800 p-4 sm:p-6">
            <h4 className="text-sm sm:text-base text-white font-semibold mb-2">
              តើខ្ញុំអាចលុបការជាវបានទេ?
            </h4>
            <p className="text-sm text-slate-400">
              បាទ។ អ្នកអាចលុបបានគ្រប់ពេល។ អ្នកនឹងនៅតែប្រើបានរហូតដល់ចុងខែ។
            </p>
          </div>

          <div className="bg-[#0d1320] rounded-xl border border-slate-800 p-4 sm:p-6">
            <h4 className="text-sm sm:text-base text-white font-semibold mb-2">តើវីដេអូរក្សាទុកប៉ុន្មាន?</h4>
            <p className="text-sm text-slate-400">
              វីដេអូរក្សាទុក 30 ថ្ងៃ។ បន្ទាប់មកវានឹងត្រូវបានលុបដោយស្វ័យប្រវត្តិ។
            </p>
          </div>

          <div className="bg-[#0d1320] rounded-xl border border-slate-800 p-4 sm:p-6">
            <h4 className="text-sm sm:text-base text-white font-semibold mb-2">តើខ្ញុំត្រូវការកាតទេ?</h4>
            <p className="text-sm text-slate-400">
              ទេ។ Free plan ឥតគិតថ្លៃ 100%។ Pro plan ត្រូវការកាត។
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
