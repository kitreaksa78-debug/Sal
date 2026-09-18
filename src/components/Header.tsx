import React from 'react';
import { Volume2, Sparkles, Sliders, History, Activity } from 'lucide-react';
import { SystemConfigStatus } from '../types';

interface HeaderProps {
  activeTab: 'studio' | 'history' | 'status';
  setActiveTab: (tab: 'studio' | 'history' | 'status') => void;
  configStatus?: SystemConfigStatus | null;
  onOpenConfig: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  configStatus,
  onOpenConfig,
}) => {
  // Fully "ready" only when every stage of the dubbing pipeline has a provider,
  // so a missing Khmer voice-over shows up here instead of silently degrading.
  const isHealthy =
    Boolean(configStatus?.translation.configured) &&
    Boolean(configStatus?.stt.configured) &&
    Boolean(configStatus?.tts.configured) &&
    Boolean(configStatus?.ffmpeg.configured);

  return (
    <header className="sticky top-0 z-40 bg-[#0b0f17]/90 backdrop-blur-md border-b border-slate-800/80 px-4 sm:px-6 py-3.5">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        {/* Logo & Title */}
        <div 
          onClick={() => setActiveTab('studio')}
          className="flex items-center gap-3 cursor-pointer group select-none"
        >
          <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 shadow-lg shadow-emerald-500/20 text-white font-bold group-hover:scale-105 transition-transform duration-200">
            <Volume2 className="w-5 h-5" />
            <Sparkles className="w-3.5 h-3.5 absolute -top-1 -right-1 text-amber-300 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white flex items-center">
                KhmerDub<span className="text-emerald-400 font-extrabold ml-0.5">AI</span>
              </h1>
              <span className="hidden sm:inline-block text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                PRO DUBBING
              </span>
            </div>
            <p className="text-xs text-slate-400 font-light flex items-center gap-1">
              <span>វេទិកាបកប្រែ និងបញ្ចូលសំឡេងខ្មែរ AI</span>
            </p>
          </div>
        </div>

        {/* Navigation Tabs (Mobile-friendly touch targets) */}
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('studio')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors min-h-[42px] ${
              activeTab === 'studio'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
            }`}
          >
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <span>ស្ទូឌីយោ</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors min-h-[42px] ${
              activeTab === 'history'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
            }`}
          >
            <History className="w-4 h-4 text-slate-400" />
            <span className="hidden sm:inline">ប្រវត្តិ</span>
          </button>

          {/* System Status Pill / Button */}
          <button
            type="button"
            onClick={onOpenConfig}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-300 hover:bg-slate-800/60 transition-colors border border-slate-800 min-h-[42px]"
            title="ពិនិត្យស្ថានភាពប្រព័ន្ធ និង API (System Status)"
          >
            <Activity className="w-4 h-4 text-emerald-400" />
            <span className="hidden sm:inline">ប្រព័ន្ធ</span>
            <span
              className={`w-2 h-2 rounded-full ${
                isHealthy ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
          </button>
        </div>
      </div>
    </header>
  );
};
