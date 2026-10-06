import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Languages,
  Link2,
  Loader2,
  Plug,
  Rocket,
  TriangleAlert,
  Unplug,
  XCircle,
} from 'lucide-react';
import {
  NllbConnectionView,
  NllbTestResult,
  clearNllbConnection,
  getNllbConnection,
  saveNllbConnection,
  testNllbConnection,
} from '../lib/api';
import {
  normaliseServiceKey,
  normaliseServiceUrl,
  parseServicePaste,
} from '@/server/utils/serviceConnection';

interface NllbPanelProps {
  /** Only the app owner sees this: the translator belongs to the whole app. */
  visible: boolean;
}

/**
 * Admin setup for the translation engine.
 *
 * Translation runs on **NLLB-200** (`facebook/nllb-200-distilled-600M`), served
 * from a Google Colab session because the model needs ~1.5 GB of RAM and the free
 * Render instance has 512 MB. A Colab quick tunnel gets a new hostname every time
 * it is reopened, so the address lives here rather than only in environment
 * variables: pasting the new URL is the whole job, with no redeploy.
 */
export const NllbPanel: React.FC<NllbPanelProps> = ({ visible }) => {
  const [connection, setConnection] = useState<NllbConnectionView | null>(null);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'clear' | null>('load');
  const [status, setStatus] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const apply = (next: NllbConnectionView) => {
    setConnection(next);
    setUrl(next.url);
  };

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    void (async () => {
      setBusy('load');
      try {
        const next = await getNllbConnection();
        if (cancelled) return;
        apply(next);
        // Open by itself while nothing is connected, so the setup steps are visible.
        setOpen(!next.url);
      } catch (err: any) {
        if (cancelled) return;
        setStatus({ tone: 'error', text: err?.message || 'មិនអាចអានការកំណត់បានទេ។' });
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible]);

  if (!visible) return null;

  const pinned = connection?.source === 'pinned';

  /**
   * Filling the two fields from one paste.
   *
   * Colab ends by printing the pair under labels (`URL : …` / `API Key : …`), and
   * selecting that block is the obvious thing to do on a phone. A paste that
   * carries an address fills the URL field — and the key too when the block
   * carried one — while the label, the quotes and a missing `https://` are
   * stripped on the way in. Anything unrecognised is left to the browser.
   */
  const handlePaste =
    (field: 'url' | 'apiKey') => (event: React.ClipboardEvent<HTMLInputElement>) => {
      const { url: pastedUrl, apiKey: pastedKey } = parseServicePaste(
        event.clipboardData.getData('text')
      );
      if (field === 'url' && pastedUrl) {
        event.preventDefault();
        setUrl(pastedUrl);
        if (pastedKey) setApiKey(pastedKey);
      } else if (field === 'apiKey' && pastedKey) {
        event.preventDefault();
        setApiKey(pastedKey);
      }
    };

  const handleSave = async () => {
    setBusy('save');
    setStatus(null);
    try {
      apply(
        await saveNllbConnection({
          url: normaliseServiceUrl(url),
          apiKey: normaliseServiceKey(apiKey),
        })
      );
      setStatus({
        tone: 'ok',
        text: 'រក្សាទុករួចរាល់។ ឥឡូវសាកល្បងការតភ្ជាប់ដើម្បីបញ្ជាក់ថាវាបកប្រែបាន។ (Saved — run the test to confirm.)',
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
      // Pasting the new tunnel URL (and, when it changed, the key) and pressing
      // this button is the whole job — both fields are saved first.
      const typed = normaliseServiceUrl(url);
      const keyTyped = normaliseServiceKey(apiKey);
      if (typed && (typed !== connection?.url || keyTyped)) {
        apply(await saveNllbConnection({ url: typed, apiKey: keyTyped }));
      }
      const result: NllbTestResult = await testNllbConnection();
      if (result.ok) {
        setStatus({
          tone: 'ok',
          text: ['ដំណើរការល្អ!', result.service || null, `${result.latencyMs} ms`, result.detail]
            .filter(Boolean)
            .join(' · '),
        });
      } else {
        setStatus({
          tone: 'error',
          text: `${result.service ? `${result.service} — ` : ''}${result.detail}`,
        });
      }
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'ការសាកល្បងបរាជ័យ។' });
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy('clear');
    setStatus(null);
    try {
      apply(await clearNllbConnection());
      setStatus({
        tone: 'warn',
        text: 'បានផ្តាច់។ ការងារថ្មីនឹងមិនបកប្រែទេ រហូតដល់ភ្ជាប់ NLLB API ឡើងវិញ។ (Cleared — new jobs cannot translate until an NLLB API is connected again.)',
      });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'មិនអាចផ្តាច់បានទេ។' });
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(connection?.url);

  return (
    <div className="bg-[#111827]/80 rounded-2xl border border-slate-800/90 backdrop-blur-sm shadow-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 p-4 sm:p-5 text-left hover:bg-slate-900/40 transition-colors"
      >
        <div className="w-10 h-10 rounded-lg bg-violet-500/15 text-violet-300 flex items-center justify-center shrink-0 border border-violet-500/30">
          <Languages className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm sm:text-base font-semibold text-white">បកប្រែ · NLLB API</h3>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
              ADMIN
            </span>
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                connected
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-slate-800/60 text-slate-400 border-slate-700'
              }`}
            >
              {connected ? 'ភ្ជាប់រួច' : 'មិនទាន់ភ្ជាប់'}
            </span>
          </div>
          <p className={`text-xs mt-1 truncate ${connected ? 'text-emerald-300' : 'text-slate-400'}`}>
            {connection
              ? `NLLB-200 · ${connection.model}${connection.url ? ` · ${connection.url}` : ''}`
              : 'កំពុងផ្ទុក...'}
          </p>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-5 space-y-4 border-t border-slate-800/80 pt-4">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-violet-950/20 border border-violet-500/30">
            <Rocket className="w-4 h-4 text-violet-300 shrink-0 mt-0.5" />
            <div className="text-[11px] text-slate-300 leading-relaxed space-y-1">
              <p className="font-semibold text-violet-200">⭐ បើក NLLB-200 លើ Google Colab (GPU)</p>
              <p>
                ១. បើក <code className="text-violet-300">tools/nllb-colab/nllb_colab.ipynb</code> ក្នុង Colab រួចជ្រើស
                Runtime → Change runtime type → <b>T4 GPU</b>។ (មិនចង់ប្រើ notebook? paste បន្ទាត់ខាងក្រោមក្នុង cell មួយ។)
              </p>
              <p className="break-all">
                <code className="text-violet-300">
                  !curl -fsSL
                  https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/nllb-colab/colab-start.sh | sh
                </code>
              </p>
              <p>
                ២. វាបង្ហាញ <b>URL</b> និង <b>API Key</b> — paste ទាំងពីរក្នុងប្រអប់ខាងក្រោម រួចចុច «រក្សាទុក និងសាកល្បង»។
                ជោគជ័យ = ឃើញ <code className="text-violet-300">cuda</code> និងប្រយោគខ្មែរសាកល្បងមួយ។
              </p>
              <p>
                ៣. ទុក tab Colab ចោលបើកចុះ — បិទ tab ឬទុក idle ~៩០ នាទី = session ដាច់ ហើយ URL ស្លាប់។
                ពេលនោះ រត់ cell នោះម្ដងទៀត រួច paste URL ថ្មី (Key ដដែល) ក្នុងប្រអប់ខាងក្រោម។
              </p>
              <p className="text-slate-400">
                ការបកប្រែប្រើ <b>NLLB-200</b> តែមួយ (គ្មាន Gemini/Groq ក្នុងជំហានបកប្រែទេ)។ ការស្តាប់ចាប់អក្សរ (Groq Whisper)
                និងជំហានផ្សេងទៀតមិនប្តូរទេ។
              </p>
            </div>
          </div>

          {connection && !connected && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-950/30 border border-amber-500/30">
              <TriangleAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-200 leading-relaxed">
                មិនទាន់ភ្ជាប់ NLLB API ទេ — ការងារបកប្រែនឹងបរាជ័យនៅជំហានបកប្រែ។ សូមបើក NLLB លើ Colab រួច paste URL
                ខាងក្រោម។ (No NLLB API: the translate step cannot run until one is connected.)
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-violet-400" />
              <span>URL របស់ NLLB API</span>
            </label>
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={handlePaste('url')}
              readOnly={pinned}
              placeholder="https://xxxx.trycloudflare.com"
              className={`w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs border border-slate-800 placeholder:text-slate-600 focus:outline-none ${
                pinned
                  ? 'bg-slate-900/40 text-slate-400'
                  : 'bg-slate-900/60 text-slate-200 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20'
              }`}
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              ចម្លងបន្ទាត់ដែល Colab បង្ហាញដាក់ទីនេះបាន៖ ទាំង URL តែម្នាក់ឯង ឬទាំងប្លុកពេញ
              («URL : … / API Key : …») — ប្រព័ន្ធស្រង់យកតែ URL ហើយបើមាន Key ក្នុងនោះ
              វាបំពេញឲ្យក្នុងប្រអប់ API Key ដោយស្វ័យប្រវត្តិ។ (Paste the Colab URL, or the whole
              block it printed — only the address is kept, and its key fills the field below.)
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-violet-400" />
              <span>API Key</span>
              {connection?.hasApiKey && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 tracking-normal normal-case">
                  បានរក្សាទុក
                </span>
              )}
            </label>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onPaste={handlePaste('apiKey')}
              placeholder={connection?.hasApiKey ? 'ទុកទទេ = ប្រើ key ដែលរក្សាទុករួច' : 'key របស់ NLLB API'}
              className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/60 text-slate-200 border border-slate-800 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20"
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Colab បង្ហាញ key នេះពេលបើក API — ដាក់វាឱ្យដូចគ្នា ដើម្បីកុំឱ្យអ្នកណាមាន URL អាចប្រើម៉ាស៊ីនរបស់អ្នកបាន។
              ទុកទទេ = រក្សា key ដែលបានរក្សាទុកពីមុន។
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {!pinned && (
              <button
                type="button"
                onClick={handleSave}
                disabled={busy !== null || !url}
                className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-violet-500/20 text-violet-200 border border-violet-500/40 hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                រក្សាទុក (Save)
              </button>
            )}

            <button
              type="button"
              onClick={handleTest}
              disabled={busy !== null || !url.trim()}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              រក្សាទុក និងសាកល្បង
            </button>

            {connection?.source === 'app' && (
              <button
                type="button"
                onClick={handleClear}
                disabled={busy !== null}
                className="min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-slate-900/60 text-slate-300 border border-slate-800 hover:border-slate-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                <Unplug className="w-4 h-4" />
                ផ្តាច់
              </button>
            )}
          </div>

          {status && (
            <div
              className={`flex items-start gap-2 p-3 rounded-xl border text-[11px] leading-relaxed ${
                status.tone === 'ok'
                  ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200'
                  : status.tone === 'warn'
                  ? 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                  : 'bg-rose-950/30 border-rose-500/30 text-rose-200'
              }`}
            >
              {status.tone === 'ok' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : status.tone === 'warn' ? (
                <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span className="break-words">{status.text}</span>
            </div>
          )}

          {connection?.source === 'env' && (
            <p className="text-[10px] text-slate-500 leading-relaxed">
              បច្ចុប្បន្នកំពុងប្រើ <code className="text-slate-400">NLLB_TRANSLATION_URL</code> ពី environment។
              ការរក្សាទុកខាងលើនឹងជំនួសវា។
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default NllbPanel;
