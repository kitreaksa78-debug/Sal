import React from 'react';
import { Sliders, Sparkles, Mic, Music, Subtitles, Video, Languages } from 'lucide-react';
import { JobSettings } from '../types';

interface TranslationSettingsProps {
  settings: JobSettings;
  onChange: (settings: JobSettings) => void;
  disabled?: boolean;
}

export const TranslationSettings: React.FC<TranslationSettingsProps> = ({
  settings,
  onChange,
  disabled = false,
}) => {
  const update = <K extends keyof JobSettings>(key: K, val: JobSettings[K]) => {
    onChange({ ...settings, [key]: val });
  };

  return (
    <div className="bg-[#111827]/80 rounded-2xl border border-slate-800/90 p-4 sm:p-6 backdrop-blur-sm shadow-xl space-y-5 sm:space-y-6">
      {/* Smart Voice Hero Card */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-950/40 via-teal-950/20 to-slate-900/40 border border-emerald-500/30">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 border border-emerald-500/30">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm sm:text-base font-semibold text-white">Smart Voice</h3>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  AI RECOMMEND
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                Smart Voice automatically detects dialogue and prepares natural Khmer dubbing while preserving background audio.
              </p>
            </div>
          </div>

          <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
            <input
              type="checkbox"
              checked={settings.smartVoice}
              disabled={disabled}
              onChange={(e) => update('smartVoice', e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
        {/* Language & Style */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5 text-emerald-400" />
            <span>ទម្រង់បកប្រែ (Translation Style)</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => update('translationStyle', 'natural')}
              className={`px-3 py-2.5 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                settings.translationStyle === 'natural'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="font-bold text-[13px]">បែបនិយាយ</span>
              <span className="text-[10px] text-slate-400 opacity-80">Natural Spoken</span>
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => update('translationStyle', 'formal')}
              className={`px-3 py-2.5 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                settings.translationStyle === 'formal'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="font-bold text-[13px]">បែបផ្លូវការ</span>
              <span className="text-[10px] text-slate-400 opacity-80">Formal Khmer</span>
            </button>
          </div>
        </div>

        {/* Voice Gender */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5 text-emerald-400" />
            <span>សំឡេងតួអង្គ (Voice)</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'auto', km: 'ស្វ័យប្រវត្ត', en: 'Auto' },
              { id: 'male', km: 'ប្រុស', en: 'Male' },
              { id: 'female', km: 'ស្រី', en: 'Female' },
            ].map((v) => (
              <button
                key={v.id}
                type="button"
                disabled={disabled}
                onClick={() => update('voice', v.id as any)}
                className={`px-2 py-2 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                  settings.voice === v.id
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
                }`}
              >
                <span className="font-bold text-xs">{v.km}</span>
                <span className="text-[10px] text-slate-400 opacity-80">{v.en}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Voice Emotion / Style */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-emerald-400" />
            <span>ទឹកដមសំឡេង (Voice Style)</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'natural', km: 'ធម្មជាតិ', en: 'Natural' },
              { id: 'calm', km: 'ស្រទន់/ស្ងប់', en: 'Calm' },
              { id: 'energetic', km: 'រស់រវើក', en: 'Energetic' },
              { id: 'dramatic', km: 'រំជួលចិត្ត', en: 'Dramatic' },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                onClick={() => update('voiceStyle', s.id as any)}
                className={`px-3 py-2 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex items-center justify-between gap-2 ${
                  settings.voiceStyle === s.id
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
                }`}
              >
                <span className="font-semibold text-xs">{s.km}</span>
                <span className="text-[10px] text-slate-400">{s.en}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Background Music Handling */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Music className="w-3.5 h-3.5 text-emerald-400" />
            <span>ភ្លេងផ្ទៃខាងក្រោយ (Background Music)</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'keep', km: 'រក្សាភ្លេង', en: 'Keep' },
              { id: 'reduce', km: 'បន្ថយភ្លេង', en: 'Reduce' },
              { id: 'remove', km: 'លុបភ្លេង', en: 'Remove' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                onClick={() => update('backgroundMusic', m.id as any)}
                className={`px-2 py-2 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                  settings.backgroundMusic === m.id
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
                }`}
              >
                <span className="font-bold text-xs">{m.km}</span>
                <span className="text-[10px] text-slate-400 opacity-80">{m.en}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Subtitles Option */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Subtitles className="w-3.5 h-3.5 text-emerald-400" />
            <span>អក្សររត់ខ្មែរ (Khmer Subtitles)</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => update('subtitle', true)}
              className={`px-3 py-2.5 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                settings.subtitle
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                  : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="font-bold text-[13px]">បើក (ON)</span>
              <span className="text-[10px] text-slate-400 opacity-80">SRT / VTT</span>
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => update('subtitle', false)}
              className={`px-3 py-2.5 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                !settings.subtitle
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                  : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="font-bold text-[13px]">បិទ (OFF)</span>
              <span className="text-[10px] text-slate-400 opacity-80">No Subs</span>
            </button>
          </div>
        </div>

        {/* Output Resolution Quality */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Video className="w-3.5 h-3.5 text-emerald-400" />
            <span>គុណភាពវីដេអូ (Output Quality)</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'original', km: 'ទំហំដើម', en: 'Original' },
              { id: '1080p', km: '1080p', en: 'Full HD' },
              { id: '720p', km: '720p', en: 'HD' },
            ].map((q) => (
              <button
                key={q.id}
                type="button"
                disabled={disabled}
                onClick={() => update('outputQuality', q.id as any)}
                className={`px-2 py-2 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                  settings.outputQuality === q.id
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
                }`}
              >
                <span className="font-bold text-xs">{q.km}</span>
                <span className="text-[10px] text-slate-400 opacity-80">{q.en}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
