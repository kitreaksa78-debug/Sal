import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  GeminiSettingsView,
  clearGeminiKeys,
  getGeminiSettings,
  saveGeminiSettings,
  testGeminiKeys,
} from '../lib/api';

interface GeminiPanelProps {
  /** Told the studio whether a key exists, so its start button can stay disabled. */
  onConfiguredChange?: (configured: boolean) => void;
}

/** Green is ready, red is out of quota or refused — the same language the rotation uses. */
function dotClass(state: 'ready' | 'cooling' | 'invalid'): string {
  if (state === 'ready') return 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]';
  return 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]';
}

function stateLabel(state: 'ready' | 'cooling' | 'invalid'): string {
  if (state === 'ready') return 'ប្រើបាន';
  if (state === 'cooling') return 'អស់កំណត់';
  return 'បដិសេធ';
}

/** "នៅ 12:04" — when a red slot becomes green again. */
function retryText(retryAt: string | null): string | null {
  if (!retryAt) return null;
  const seconds = Math.max(0, Math.round((new Date(retryAt).getTime() - Date.now()) / 1000));
  if (seconds <= 0) return 'ដំណើរការវិញហើយ';
  if (seconds < 60) return `រង់ចាំ ${seconds}s`;
  return `រង់ចាំ ${Math.ceil(seconds / 60)} នាទី`;
}

/**
 * The Gemini keys and models behind «សម្អាតសំឡេង».
 *
 * The panel exists because a free AI Studio key runs out of quota every day, and
 * the owner needs two things visible: which key/model is being used right now,
 * and which ones are red (so the rotation to the next green pair is not a
 * mystery). Keys are only ever shown masked — the browser never receives one.
 */
export const GeminiPanel: React.FC<GeminiPanelProps> = ({ onConfiguredChange }) => {
  const [settings, setSettings] = useState<GeminiSettingsView | null>(null);
  const [keysText, setKeysText] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'clear' | null>('load');
  const [status, setStatus] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const apply = (next: GeminiSettingsView) => {
    setSettings(next);
    setModelsText(next.savedModels.join(', '));
    onConfiguredChange?.(next.configured);
    if (!next.configured) setOpen(true);
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setBusy('load');
      try {
        const next = await getGeminiSettings();
        if (!cancelled) apply(next);
      } catch (err: any) {
        if (!cancelled) {
          setStatus({ tone: 'error', text: err?.message || 'មិនអាចអានការកំណត់ Gemini បានទេ។' });
        }
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setBusy('save');
    setStatus(null);
    try {
      const next = await saveGeminiSettings({
        ...(keysText.trim() ? { keys: keysText } : {}),
        ...(modelsText.trim() ? { models: modelsText } : {}),
      });
      apply(next);
      setKeysText('');
      setStatus({
        tone: 'ok',
        text: `រក្សាទុករួចរាល់ — ${next.keyCount} key, ${next.models.length} model។`,
      });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'មិនអាចរក្សាទុកបានទេ។' });
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setBusy('test');
    setStatus(null);
    try {
      const result = await testGeminiKeys();
      if (result.settings) apply(result.settings);
      else setSettings(await getGeminiSettings());
      setStatus({
        tone: 'ok',
        text: `Gemini ឆ្លើយតបបាន ✅ — ${result.detail} · ${result.latencyMs}ms` +
          (result.attempts > 1 ? ` (សាកល្បង ${result.attempts} ដង រហូតបាន key/model ដែលប្រើបាន)` : ''),
      });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'ការសាកល្បងបរាជ័យ។' });
      try {
        apply(await getGeminiSettings());
      } catch {}
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy('clear');
    setStatus(null);
    try {
      const next = await clearGeminiKeys();
      apply(next);
      setKeysText('');
      setStatus({ tone: 'warn', text: 'លុប key ដែលរក្សាទុករួចរាល់។' });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'មិនអាចលុបបានទេ។' });
    } finally {
      setBusy(null);
    }
  };

  const configured = settings?.configured ?? false;
  const active = settings?.active ?? null;

  return (
    <section className="bg-[#0d1420]/90 rounded-2xl border border-slate-800 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-3 p-4 text-left"
      >
        <div className="w-10 h-10 rounded-xl bg-violet-500/15 text-violet-300 border border-violet-500/30 flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-white leading-tight">សម្អាតសំឡេង · Gemini</h2>
          <p className="text-[11px] text-slate-400 truncate">
            {busy === 'load'
              ? 'កំពុងអាន...'
              : configured
              ? active
                ? `កំពុងប្រើ ${active.keyLabel} · ${active.model}`
                : 'key ទាំងអស់ក្រហម — រង់ចាំ ឬបន្ថែម key ថ្មី'
              : 'មិនទាន់មាន Gemini key'}
          </p>
        </div>
        <span
          className={`text-[10px] font-bold px-2 py-1 rounded-full border shrink-0 ${
            configured
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : 'bg-red-500/15 text-red-300 border-red-500/30'
          }`}
        >
          {configured ? `${settings?.keyCount ?? 0} key` : 'ត្រូវការ key'}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-800/80 pt-4">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            ដាក់ Gemini API key មួយ ឬច្រើន (បន្ទាត់មួយក្នុងមួយ key ឬខណ្ឌដោយសញ្ញាក្បៀស)។
            ពេល key មួយអស់កំណត់ (ក្រហម) ប្រព័ន្ធប្តូរទៅ key បន្ទាប់ដោយស្វ័យប្រវត្តិ — ហើយបើ model
            មួយអស់ វាប្តូរទៅ model បន្ទាប់ក្នុងបញ្ជីខាងក្រោម។ Key មិនត្រូវបានបង្ហាញវិញទេ។
          </p>

          {/* The rotation, model by model and key by key. */}
          {settings && settings.keyCount > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-slate-900/50 border border-slate-800 p-3 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Model</p>
                {settings.models.map((model) => (
                  <div key={model} className="flex items-center gap-2 text-[11px]">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass(model.state)}`} />
                    <span className="font-mono text-slate-200 truncate flex-1">{model.name}</span>
                    <span className="text-slate-500 shrink-0">
                      {model.state === 'ready'
                        ? `${model.readyKeys}/${model.totalKeys} key`
                        : retryText(model.retryAt) || stateLabel(model.state)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="rounded-xl bg-slate-900/50 border border-slate-800 p-3 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Key</p>
                {settings.keys.map((key) => (
                  <div key={key.label} className="flex items-center gap-2 text-[11px]">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass(key.state)}`} />
                    <span className="text-slate-200 shrink-0">{key.label}</span>
                    <span className="font-mono text-slate-500 truncate flex-1">{key.masked}</span>
                    <span className="text-slate-500 shrink-0">
                      {key.state === 'ready'
                        ? `${key.readyModels}/${key.totalModels} model`
                        : retryText(key.retryAt) || stateLabel(key.state)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-violet-400" />
              <span>Gemini API keys</span>
              {settings?.hasSavedKeys && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 tracking-normal normal-case">
                  បានរក្សាទុក
                </span>
              )}
            </label>
            <textarea
              value={keysText}
              onChange={(event) => setKeysText(event.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                settings?.hasSavedKeys
                  ? 'ទុកទទេ = ប្រើ key ដែលរក្សាទុករួច · បិទភ្ជាប់ key ថ្មីដើម្បីជំនួស'
                  : 'បិទភ្ជាប់ key ទី១\nបិទភ្ជាប់ key ទី២'
              }
              className="w-full px-3 py-2.5 rounded-xl text-[11px] font-mono bg-slate-900/60 text-slate-200 border border-slate-800 placeholder:text-slate-600 placeholder:font-sans focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 resize-y"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
              លំដាប់ model (ស្រេចចិត្ត)
            </label>
            <input
              value={modelsText}
              onChange={(event) => setModelsText(event.target.value)}
              spellCheck={false}
              placeholder={settings?.defaultModels.join(', ') || 'gemini-2.5-flash, gemini-2.5-flash-lite'}
              className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-[11px] font-mono bg-slate-900/60 text-slate-200 border border-slate-800 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20"
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              ទុកទទេ = ប្រើលំនាំដើម។ បញ្ជីនេះជាលំដាប់ដែលប្រព័ន្ធសាកល្បង — model ដំបូងពិសិដ្ឋជាងគេ។
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy !== null || (!keysText.trim() && !modelsText.trim())}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-violet-500/20 text-violet-200 border border-violet-500/40 hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              រក្សាទុក key
            </button>

            <button
              type="button"
              onClick={handleTest}
              disabled={busy !== null || !configured}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'test' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              សាកល្បង key
            </button>

            {settings?.hasSavedKeys && (
              <button
                type="button"
                onClick={handleClear}
                disabled={busy !== null}
                title="លុប key ដែលរក្សាទុកក្នុងគេហទំព័រ (ប្រើ GEMINI_API_KEYS វិញ)"
                className="min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-slate-900/60 text-slate-400 border border-slate-800 hover:border-red-500/40 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {busy === 'clear' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                លុប
              </button>
            )}
          </div>

          {status && (
            <p
              className={`text-[11px] leading-relaxed rounded-xl px-3 py-2 border ${
                status.tone === 'ok'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                  : status.tone === 'warn'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                  : 'bg-red-500/10 border-red-500/30 text-red-200'
              }`}
            >
              {status.text}
            </p>
          )}

          {!configured && (
            <p className="text-[10px] text-slate-500 leading-relaxed flex items-start gap-1.5">
              <RefreshCw className="w-3 h-3 mt-0.5 shrink-0" />
              មិនទាន់មាន key ទេ — ការបញ្ចូលឯកសារនឹងត្រូវបដិសេធរហូតដល់មាន key មួយ។
            </p>
          )}
        </div>
      )}
    </section>
  );
};

export default GeminiPanel;
