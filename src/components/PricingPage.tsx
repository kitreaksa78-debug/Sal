import React from 'react';
import { Check, Zap, Crown, Video, Clock, Download, Headphones } from 'lucide-react';
import { CheckoutButton } from './CheckoutButton';
import { ProActivate } from './ProActivate';
import { getPlan, PRO_PRICE_USD } from '../lib/usage';

interface PricingPageProps {
  onSelectPlan?: (plan: 'free' | 'pro') => void;
  onPlanChange?: (plan: 'free' | 'pro') => void;
}

export const PricingPage: React.FC<PricingPageProps> = ({ onSelectPlan, onPlanChange }) => {
  const isPro = getPlan() === 'pro';

  return (
    <div className="max-w-5xl mx-auto py-12 px-4">
      {/* Header */}
      <div className="text-center mb-12">
        <h2 className="text-4xl font-bold text-white mb-4">
          តម្លៃ <span className="text-emerald-400">សាមញ្ញ</span>
        </h2>
        <p className="text-lg text-slate-400 max-w-2xl mx-auto">
          ចាប់ផ្តើមដោយឥតគិតថ្លៃ។ អភិវឌ្ឍន៍ជាមួយ Pro នៅពេលអ្នករួចរាល់។
        </p>
      </div>

      {/* Plans Grid */}
      <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
        {/* Free Plan */}
        <div className="relative bg-[#0d1320] rounded-2xl border border-slate-800 p-8 hover:border-slate-700 transition-all duration-300">
          <div className="mb-6">
            <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center mb-4">
              <Video className="w-6 h-6 text-slate-400" />
            </div>
            <h3 className="text-2xl font-bold text-white">Free</h3>
            <div className="mt-2">
              <span className="text-4xl font-bold text-white">$0</span>
              <span className="text-slate-400 ml-2">/ខែ</span>
            </div>
          </div>

          <ul className="space-y-4 mb-8">
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300"><strong className="text-white">3 វីដេអូ</strong>/ថ្ងៃ</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300"><strong className="text-white">2 នាទី</strong> ក្នុងមួយវីដេអូ</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300"><strong className="text-white">720p</strong> output</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300">Khmer subtitles</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300">AI translation</span>
            </li>
          </ul>

          <button
            onClick={() => onSelectPlan?.('free')}
            className="w-full py-3 px-6 rounded-xl border border-slate-700 text-white font-semibold hover:bg-slate-800 transition-colors"
          >
            {isPro ? 'បន្តប្រើប្រាស់' : 'ចាប់ផ្តើមឥតគិតថ្លៃ'}
          </button>
        </div>

        {/* Pro Plan */}
        <div className="relative bg-gradient-to-b from-emerald-900/20 to-[#0d1320] rounded-2xl border border-emerald-500/30 p-8 hover:border-emerald-500/50 transition-all duration-300 shadow-lg shadow-emerald-500/10">
          {/* Popular Badge */}
          <div className="absolute -top-4 left-1/2 -translate-x-1/2">
            <span className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-sm font-bold px-4 py-1.5 rounded-full shadow-lg">
              <Crown className="w-4 h-4 inline mr-1" />
              POPULAR
            </span>
          </div>

          <div className="mb-6 mt-2">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center mb-4">
              <Zap className="w-6 h-6 text-emerald-400" />
            </div>
            <h3 className="text-2xl font-bold text-white">Pro</h3>
            <div className="mt-2">
              <span className="text-4xl font-bold text-white">${PRO_PRICE_USD}</span>
              <span className="text-slate-400 ml-2">/ខែ</span>
            </div>
          </div>

          <ul className="space-y-4 mb-8">
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300"><strong className="text-white">វីដេអូឥតកំណត់</strong></span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300"><strong className="text-white">30 នាទី</strong> ក្នុងមួយវីដេអូ</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300"><strong className="text-white">1080p</strong> output</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300">Priority processing</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300">API access</span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <span className="text-slate-300">No watermark</span>
            </li>
          </ul>

          <CheckoutButton className="w-full" />
        </div>
      </div>

      {/* Restore a purchase / unlock on another device */}
      <div className="mt-10 max-w-4xl mx-auto">
        <ProActivate onPlanChange={onPlanChange} />
      </div>

      {/* Features Comparison */}
      <div className="mt-16 max-w-4xl mx-auto">
        <h3 className="text-2xl font-bold text-white text-center mb-8">ការប្រៀបធៀប</h3>
        
        <div className="bg-[#0d1320] rounded-2xl border border-slate-800 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left p-4 text-slate-400 font-medium">លក្ខណៈ</th>
                <th className="text-center p-4 text-slate-400 font-medium">Free</th>
                <th className="text-center p-4 text-emerald-400 font-medium">Pro</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-800/50">
                <td className="p-4 text-slate-300 flex items-center gap-2">
                  <Video className="w-4 h-4 text-slate-500" />
                  វីដេអូ/ថ្ងៃ
                </td>
                <td className="p-4 text-center text-slate-300">3</td>
                <td className="p-4 text-center text-emerald-400 font-semibold">ឥតកំណត់</td>
              </tr>
              <tr className="border-b border-slate-800/50">
                <td className="p-4 text-slate-300 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-500" />
                  រយៈពេលវីដេអូ
                </td>
                <td className="p-4 text-center text-slate-300">2 នាទី</td>
                <td className="p-4 text-center text-emerald-400 font-semibold">30 នាទី</td>
              </tr>
              <tr className="border-b border-slate-800/50">
                <td className="p-4 text-slate-300 flex items-center gap-2">
                  <Download className="w-4 h-4 text-slate-500" />
                  Output quality
                </td>
                <td className="p-4 text-center text-slate-300">720p</td>
                <td className="p-4 text-center text-emerald-400 font-semibold">1080p</td>
              </tr>
              <tr className="border-b border-slate-800/50">
                <td className="p-4 text-slate-300 flex items-center gap-2">
                  <Headphones className="w-4 h-4 text-slate-500" />
                  Khmer TTS
                </td>
                <td className="p-4 text-center text-emerald-400">✅</td>
                <td className="p-4 text-center text-emerald-400">✅</td>
              </tr>
              <tr>
                <td className="p-4 text-slate-300 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-slate-500" />
                  Priority
                </td>
                <td className="p-4 text-center text-slate-500">—</td>
                <td className="p-4 text-center text-emerald-400">✅</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* FAQ */}
      <div className="mt-16 max-w-3xl mx-auto">
        <h3 className="text-2xl font-bold text-white text-center mb-8">សំណួរដែលគេសួរញឹកញាប់</h3>
        
        <div className="space-y-4">
          <div className="bg-[#0d1320] rounded-xl border border-slate-800 p-6">
            <h4 className="text-white font-semibold mb-2">តើខ្ញុំអាចលុបការជាវបានទេ?</h4>
            <p className="text-slate-400">បាទ។ អ្នកអាចលុបបានគ្រប់ពេល។ អ្នកនឹងនៅតែប្រើបានរហូតដល់ចុងខែ។</p>
          </div>
          
          <div className="bg-[#0d1320] rounded-xl border border-slate-800 p-6">
            <h4 className="text-white font-semibold mb-2">តើវីដេអូរក្សាទុកប៉ុន្មាន?</h4>
            <p className="text-slate-400">វីដេអូរក្សាទុក 30 ថ្ងៃ។ បន្ទាប់មកវានឹងត្រូវបានលុបដោយស្វ័យប្រវត្តិ។</p>
          </div>
          
          <div className="bg-[#0d1320] rounded-xl border border-slate-800 p-6">
            <h4 className="text-white font-semibold mb-2">តើខ្ញុំត្រូវការកាតទេ?</h4>
            <p className="text-slate-400">ទេ។ Free plan ឥតគិតថ្លៃ 100%។ Pro plan ត្រូវការកាត។</p>
          </div>
        </div>
      </div>
    </div>
  );
};
