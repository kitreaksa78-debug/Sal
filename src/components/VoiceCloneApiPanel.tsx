import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Link2,
  Loader2,
  Mic,
  Plug,
  Rocket,
  TriangleAlert,
  Unplug,
  XCircle,
} from 'lucide-react';
import {
  VoiceCloneConnectionView,
  VoiceCloneTestResult,
  clearVoiceCloneConnection,
  getVoiceCloneConnection,
  saveVoiceCloneConnection,
  testVoiceCloneConnection,
} from '../lib/api';
import {
  normaliseServiceKey,
  normaliseServiceUrl,
  parseServicePaste,
} from '@/server/utils/serviceConnection';
import { BADGE_TONE, studioCardStatus, useLiveStatus } from '../lib/liveStatus';

const ONE_LINER =
  '!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/voice-clone/colab-start.sh | SERVICE=1 sh';

/**
 * Setup for the machine that puts the Khmer words back in the original singer's
 * voice.
 *
 * The address lives here rather than only in environment variables because a
 * Colab quick tunnel gets a new URL every time the session is reopened —
 * pasting it in should not need a redeploy, and the key the script prints stays
 * the same one, so re-pointing is a single field.
 *
 * With nothing pasted the conversion falls back to the deployment's hosted API,
 * so the card says which of the two would run.
 */
export const VoiceCloneApiPanel: React.FC<{ onConnectionChange?: () => void }> = ({
  onConnectionChange,
}) => {
  const [connection, setConnection] = useState<VoiceCloneConnectionView | null>(null);
  const [url, setUrl] = useState('');
  /** The service's own bearer token; empty means "keep the stored one". */
  const [apiKey, setApiKey] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'clear' | null>('load');
  const [status, setStatus] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  /** The badge reads the live probe, never the saved URL alone. */
  const live = useLiveStatus();

  const apply = (next: VoiceCloneConnectionView) => {
    setConnection(next);
    setUrl(next.url);
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setBusy('load');
      try {
        const next = await getVoiceCloneConnection();
        if (cancelled) return;
        apply(next);
        // Open by itself while no free converter is connected, so the one line
        // that opens it on Colab is visible.
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
  }, []);

  /**
   * Filling the two fields from one paste: Colab ends by printing `URL : …` and
   * `API Key : …`, and selecting that block is the obvious thing to do on a
   * phone. The labels, the quotes and a missing `https://` are stripped on the
   * way in.
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
      const next = await saveVoiceCloneConnection({
        url: normaliseServiceUrl(url),
        apiKey: normaliseServiceKey(apiKey),
      });
      apply(next);
      onConnectionChange?.();
      setStatus({
        tone: 'ok',
        text: 'រក្សាទុករួចរាល់។ ឥឡូវសាកល្បងការតភ្ជាប់ដើម្បីបញ្ជាក់ថាវាដំណើរការ។ (Saved — run the test to confirm.)',
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
      // Pasting the new tunnel URL and pressing this button is the whole job:
      // whatever is in the fields is saved first, so there is no separate save
      // step to forget when the Colab session is reopened.
      const typed = normaliseServiceUrl(url);
      const keyTyped = normaliseServiceKey(apiKey);
      if (typed && (typed !== connection?.url || keyTyped)) {
        apply(await saveVoiceCloneConnection({ url: typed, apiKey: keyTyped }));
      }
      onConnectionChange?.();
      const result: VoiceCloneTestResult = await testVoiceCloneConnection();
      if (result.ok) {
        setStatus({
          tone: 'ok',
          text: ['ដំណើរការល្អ!', result.service || null, `${result.latencyMs} ms`]
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
      const next = await clearVoiceCloneConnection();
      apply(next);
      onConnectionChange?.();
      setStatus({
        tone: 'warn',
        text: 'បានផ្តាច់។ ការប្តូរសំឡេងនឹងប្រើសេវា hosted ជំនួស (បើមាន key ក្នុង deployment)។ (Cleared — the hosted API is used instead, if the deployment has a key.)',
      });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'មិនអាចផ្តាច់បានទេ។' });
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(connection?.url);
  const tone = connected ? 'text-emerald-300' : 'text-slate-400';
  const card = studioCardStatus(live, {
    hasUrl: Boolean(connection?.url),
    configuredInProcess: Boolean(connection?.configured && !connection?.url),
    kind: 'voice',
  });

  return (
    <div className="bg-[#111827]/80 rounded-2xl border border-slate-800/90 backdrop-blur-sm shadow-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 p-4 sm:p-5 text-left hover:bg-slate-900/40 transition-colors"
      >
        <div className="w-10 h-10 rounded-lg bg-emerald-500/15 text-emerald-300 flex items-center justify-center shrink-0 border border-emerald-500/30">
          <Mic className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm sm:text-base font-semibold text-white">
              ប្តូរសំឡេង · Voice Convert API
            </h3>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              ADMIN
            </span>
            <span
              title={card.hint}
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${BADGE_TONE[card.tone]}`}
            >
              {card.label}
            </span>
          </div>
          <p className={`text-xs mt-1 truncate ${tone}`}>
            {connection
              ? `${connection.provider || '—'}${connection.url ? ` · ${connection.url}` : ''}`
              : 'កំពុងផ្ទុក...'}
          </p>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-5 space-y-4 border-t border-slate-800/80 pt-4">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-emerald-950/20 border border-emerald-500/30">
            <Rocket className="w-4 h-4 text-emerald-300 shrink-0 mt-0.5" />
            <div className="text-[11px] text-slate-300 leading-relaxed space-y-1">
              <p className="font-semibold text-emerald-200">
                ⭐ ឥតគិតថ្លៃ — បើកម៉ាស៊ីនបម្លែងលើ Google Colab (GPU)
              </p>
              <p>
                ១. បើក cell មួយក្នុង Colab (Runtime → Change runtime type → <b>T4 GPU</b>) រួច paste
                បន្ទាត់នេះ៖
              </p>
              <p className="break-all">
                <code className="text-emerald-300">{ONE_LINER}</code>
              </p>
              <p>
                ២. វាបង្ហាញ <b>URL</b> និង <b>API Key</b> — paste ទាំងពីរក្នុងប្រអប់ខាងក្រោម
                (ដាក់តែមួយក្នុងប្រអប់ URL ក៏បាន ព្រោះវាស្រង់ key ឲ្យផង) រួចចុច «រក្សាទុក
                និងសាកល្បង»។ ពេលជោគជ័យ វាបង្ហាញ <code className="text-emerald-300">cuda</code> —
                GPU កំពុងធ្វើការ។
              </p>
              <p>
                ៣. ទុក tab Colab បើកចុះ — បិស tab ឬ idle ~៩០ នាទី = session ដាច់ URL ស្លាប់។ រត់ cell
                នោះម្តងទៀត (key ដដែល) រួច paste URL ថ្មី។
              </p>
            </div>
          </div>

          {!connected && connection?.source !== 'env' && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-900/60 border border-slate-800">
              <TriangleAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <p className="text-[11px] text-slate-300 leading-relaxed">
                មិនទាន់ភ្ជាប់ម៉ាស៊ីនឥតគិតថ្លៃទេ — ការប្តូរសំឡេងនឹងប្រើសេវា hosted
                (ត្រូវការ key ក្នុង deployment) ឬបរាជ័យបើគ្មានវា។ (No free converter connected: the
                hosted API is used instead, or the clone fails without one.)
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>URL របស់ Voice Convert API</span>
            </label>
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={handlePaste('url')}
              placeholder="https://xxxx.trycloudflare.com"
              className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/60 text-slate-200 border border-slate-800 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20"
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              ចម្លងបន្ទាត់ដែល Colab បង្ហាញដាក់ទីនេះបាន៖ ទាំង URL តែម្នាក់ឯង ឬទាំងប្លុកពេញ
              («URL : … / API Key : …») — ប្រព័ន្ធស្រង់យកតែ URL ហើយបើមាន Key ក្នុងនោះ
              វាបំពេញឲ្យក្នុងប្រអប់ API Key ដោយស្វ័យប្រវត្តិ។
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-emerald-400" />
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
              placeholder={
                connection?.hasApiKey ? 'ទុកទទេ = ប្រើ key ដែលរក្សាទុករួច' : 'key ដែល Colab បង្ហាញ'
              }
              className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/60 text-slate-200 border border-slate-800 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20"
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              ទុកទទេ = រក្សា key ដែលបានរក្សាទុកពីមុន។ ទីនេះពាក្យតែមួយទេ តែកាតនេះមិនដែលបង្ហាញ
              key ដែលរក្សាទុកឡើយ។
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy !== null || !url}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
              រក្សាទុក (Save)
            </button>

            <button
              type="button"
              onClick={handleTest}
              disabled={busy !== null || (!url.trim() && !connection?.configured)}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
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
              បច្ចុប្បន្នកំពុងប្រើ <code className="text-slate-400">VOICE_CLONE_SERVICE_URL</code> ពី
              environment។ ការរក្សាទុកខាងលើនឹងជំនួសវា។
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default VoiceCloneApiPanel;
