import React, { useEffect, useState } from 'react';
import {
  AudioWaveform,
  CheckCircle2,
  ChevronDown,
  Link2,
  Loader2,
  Plug,
  Smartphone,
  TriangleAlert,
  Unplug,
  XCircle,
} from 'lucide-react';
import {
  clearSeparatorConnection,
  getSeparatorConnection,
  saveSeparatorConnection,
  SeparatorConnectionView,
  SeparatorTestResult,
  testSeparatorConnection,
} from '../lib/api';

interface DemucsPanelProps {
  /** Only the app owner sees this: the stem service belongs to the whole app. */
  visible: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  demucs_api: 'Demucs API (ទូរស័ព្ទ / server)',
  audio_separator: 'audio-separator sidecar',
  demucs: 'Demucs CLI',
  local_dsp: 'FFmpeg DSP (ក្នុងម៉ាស៊ីនបម្រើ)',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Admin setup for the model that pulls the voice out of a video before dubbing.
 *
 * The address lives here rather than only in environment variables because a
 * phone served over a quick tunnel gets a new URL every time the tunnel is
 * reopened — pasting it in should not need a redeploy.
 */
export const DemucsPanel: React.FC<DemucsPanelProps> = ({ visible }) => {
  const [connection, setConnection] = useState<SeparatorConnectionView | null>(null);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'clear' | null>('load');
  const [status, setStatus] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const apply = (next: SeparatorConnectionView) => {
    setConnection(next);
    setUrl(next.url);
    setModel(next.model);
    // The stored key is never sent to the browser; an empty field keeps it.
    setApiKey('');
  };

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    void (async () => {
      setBusy('load');
      try {
        const next = await getSeparatorConnection();
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

  const handleSave = async () => {
    setBusy('save');
    setStatus(null);
    try {
      const next = await saveSeparatorConnection({ url, apiKey, model });
      apply(next);
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
      const result: SeparatorTestResult = await testSeparatorConnection();
      if (result.ok && result.stems) {
        setStatus({
          tone: 'ok',
          text: `ដំណើរការល្អ! ${result.service ? `${result.service} · ` : ''}${result.latencyMs} ms · vocals ${formatBytes(
            result.stems.vocalsBytes
          )} · instrumental ${formatBytes(result.stems.instrumentalBytes)}`,
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
      const next = await clearSeparatorConnection();
      apply(next);
      setStatus({
        tone: 'warn',
        text: 'បានផ្តាច់។ ប្រព័ន្ធនឹងប្រើការញែកក្នុងម៉ាស៊ីនបម្រើវិញ។ (Cleared — back to the built-in separation.)',
      });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'មិនអាចផ្តាច់បានទេ។' });
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(connection?.url);
  const tone = connected ? 'text-emerald-300' : 'text-slate-400';

  return (
    <div className="bg-[#111827]/80 rounded-2xl border border-slate-800/90 backdrop-blur-sm shadow-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 p-4 sm:p-5 text-left hover:bg-slate-900/40 transition-colors"
      >
        <div className="w-10 h-10 rounded-lg bg-cyan-500/15 text-cyan-300 flex items-center justify-center shrink-0 border border-cyan-500/30">
          <AudioWaveform className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm sm:text-base font-semibold text-white">ញែកភ្លេង · Demucs API</h3>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              ADMIN
            </span>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${connected ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-800/60 text-slate-400 border-slate-700'}`}>
              {connected ? 'ភ្ជាប់រួច' : 'មិនទាន់ភ្ជាប់'}
            </span>
          </div>
          <p className={`text-xs mt-1 truncate ${tone}`}>
            {connection
              ? `${PROVIDER_LABELS[connection.provider] ?? connection.provider}${connection.url ? ` · ${connection.url}` : ''}`
              : 'កំពុងផ្ទុក...'}
          </p>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-5 space-y-4 border-t border-slate-800/80 pt-4">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-900/60 border border-slate-800">
            <Smartphone className="w-4 h-4 text-cyan-300 shrink-0 mt-0.5" />
            <div className="text-[11px] text-slate-300 leading-relaxed space-y-1">
              <p className="font-semibold text-slate-200">របៀបភ្ជាប់ Demucs API ក្នុង Termux</p>
              <p>១. បើក API ក្នុង Termux (port 8000) — ឧទាហរណ៍ <code className="text-cyan-300">python demucs_api.py</code></p>
              <p>២. បើក tunnel ឲ្យចេញអ៊ីនធឺណិត៖ <code className="text-cyan-300">ssh -R 80:localhost:8000 nokey@localhost.run</code></p>
              <p>៣. ចម្លង URL <code className="text-cyan-300">https://…</code> ដែលទទួលបាន មកដាក់ក្នុងប្រអប់ខាងក្រោម</p>
              <p>៤. ចុច «រក្សាទុក» រួច «សាកល្បង» — បើជោគជ័យ ការងារបកប្រែនឹងប្រើទូរស័ព្ទញែកភ្លេងជំនួស។</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-cyan-400" />
                <span>URL របស់ Demucs API</span>
              </label>
              <input
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://xxxx.lhr.life"
                className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/60 border border-slate-800 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                API Key (បើមាន)
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={connection?.hasApiKey ? '•••••••• (រក្សាទុកដើម)' : 'មិនចាំបាច់'}
                className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/60 border border-slate-800 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="htdemucs"
                className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/60 border border-slate-800 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
          >
            {advanced ? '− បិទការកំណត់កម្រិតខ្ពស់' : '+ ការកំណត់កម្រិតខ្ពស់ (endpoint)'}
          </button>

          {advanced && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                Endpoint path (ទទេ = ស្វ័យប្រវត្តិ)
              </label>
              <input
                type="text"
                value={connection?.path ?? ''}
                readOnly
                placeholder="/separate"
                className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/40 border border-slate-800 text-slate-400 placeholder:text-slate-600"
              />
              <p className="text-[10px] text-slate-500 leading-relaxed">
                បើ API របស់អ្នកប្រើ path ផ្សេង សូមកំណត់វាតាម env <code className="text-slate-400">AUDIO_SEPARATOR_PATH</code>។
                បើទទេ ប្រព័ន្ធនឹងសាកល្បង <code className="text-slate-400">/separate</code> និង path ទូទៅផ្សេងទៀត។
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy !== null || !url}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
              រក្សាទុក (Save)
            </button>

            <button
              type="button"
              onClick={handleTest}
              disabled={busy !== null || !connected}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              សាកល្បងការតភ្ជាប់
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
              បច្ចុប្បន្នកំពុងប្រើ <code className="text-slate-400">AUDIO_SEPARATOR_URL</code> ពី environment។
              ការរក្សាទុកខាងលើនឹងជំនួសវា។
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DemucsPanel;
