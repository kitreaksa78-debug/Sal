import React from 'react';
import { Volume2, Sparkles, History, Crown, type LucideIcon } from 'lucide-react';

type Tab = 'welcome' | 'studio' | 'history' | 'pricing';

interface HeaderProps {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  /**
   * Welcome screen before the visitor enters the app — the tab bars stay hidden
   * so the landing page is nothing but the brand and its one CTA.
   */
  showNav?: boolean;
}

const NAV_ITEMS: { id: Exclude<Tab, 'welcome'>; label: string; Icon: LucideIcon }[] = [
  { id: 'studio', label: 'ស្ទូឌីយោ', Icon: Sparkles },
  { id: 'history', label: 'ប្រវត្តិ', Icon: History },
  { id: 'pricing', label: 'Pro', Icon: Crown },
];

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab, showNav = true }) => {
  const tabClass = (isActive: boolean) =>
    `flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors min-h-[44px] ${
      isActive
        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        : 'text-slate-300 border border-transparent hover:bg-slate-800/60 hover:text-white'
    }`;

  const iconClass = (id: Exclude<Tab, 'welcome'>) =>
    `w-4 h-4 ${id === 'pricing' ? 'text-amber-400' : id === 'studio' ? 'text-emerald-400' : 'text-slate-400'}`;

  return (
    <header className="sticky top-0 z-40 bg-[#0b0f17]/95 backdrop-blur-md border-b border-slate-800/80">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2.5 sm:py-3">
        <div className="flex items-center justify-between gap-3">
          {/* Brand — tap target that returns to the welcome screen */}
          <div
            onClick={() => setActiveTab('welcome')}
            className="flex items-center gap-2.5 sm:gap-3 min-w-0 cursor-pointer select-none group"
          >
            <span className="relative flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 shadow-lg shadow-emerald-500/20 text-white shrink-0 group-hover:scale-105 transition-transform duration-200">
              <Volume2 className="w-5 h-5" />
              <Sparkles className="w-3 h-3 absolute -top-1 -right-1 text-amber-300 animate-pulse" />
            </span>

            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <h1 className="text-base sm:text-xl font-bold tracking-tight text-white leading-tight whitespace-nowrap">
                  KhmerDub<span className="text-emerald-400 font-extrabold ml-0.5">AI</span>
                </h1>
                <span className="hidden lg:inline-block text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 whitespace-nowrap">
                  PRO DUBBING
                </span>
              </span>
              <span className="hidden sm:block text-[11px] md:text-xs text-slate-400 font-light truncate">
                វេទិកាបកប្រែ និងបញ្ចូលសំឡេងខ្មែរ AI
              </span>
            </span>
          </div>

          {/* Desktop navigation */}
          {showNav && (
            <nav className="hidden md:flex items-center gap-1.5 shrink-0">
              {NAV_ITEMS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`${tabClass(activeTab === id)} px-3`}
                >
                  <Icon className={iconClass(id)} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          )}
        </div>

        {/* Phone / tablet navigation: one full-width segmented row under the brand */}
        {showNav && (
          <nav className="md:hidden mt-2.5 grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-900/70 border border-slate-800">
            {NAV_ITEMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex flex-col items-center justify-center gap-0.5 py-1.5 px-1 rounded-lg transition-colors min-h-[52px] ${
                  activeTab === id
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : 'text-slate-300 border border-transparent active:bg-slate-800/60'
                }`}
              >
                <Icon className={iconClass(id)} />
                <span className="text-[11px] font-medium leading-none">{label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
};
