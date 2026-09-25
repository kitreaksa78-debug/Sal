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

/**
 * Stem separation is Demucs only; the labels just name the machine it runs on,
 * so the panel never suggests a different method is available.
 */
const PROVIDER_LABELS: Record<string, string> = {
  demucs_api: 'Demucs API (ទូរស័ព្ទ / server)',
  audio_separator: 'Demucs sidecar (audio-separator)',
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
 * reopened — pasting it in should not need a redeploy. When the address is
 * pinned in the app code the field is informational and only the test button
 * does anything: there is no key and no model to choose, because the phone's
 * Demucs service takes neither.
 */
export const DemucsPanel: React.FC<DemucsPanelProps> = ({ visible }) => {
  const [connection, setConnection] = useState<SeparatorConnectionView | null>(null);
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'clear' | null>('load');
  const [status, setStatus] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const apply = (next: SeparatorConnectionView) => {
    setConnection(next);
    setUrl(next.url);
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

  const pinned = connection?.source === 'pinned';

  const handleSave = async () => {
    setBusy('save');
    setStatus(null);
    try {
      const next = await saveSeparatorConnection({ url });
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
      // Pasting the new tunnel URL and pressing this button is the whole job, so
      // whatever is in the field is saved first — no separate save step to
      // forget, and no developer needed when the phone's tunnel is reopened.
      const typed = url.trim().replace(/\/+$/, '');
      if (typed && typed !== connection?.url) {
        apply(await saveSeparatorConnection({ url: typed }));
      }
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
        text: 'បានផ្តាច់។ ការញែកភ្លេងនឹងឈប់ដំណើរការ រហូតដល់ភ្ជាប់ Demucs API ឡើងវិញ។ (Cleared — separation stays off until a Demucs API is connected again.)',
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
              <p className="font-semibold text-slate-200">របៀបបើក Demucs API លើទូរស័ព្ទ</p>
              <p>
                ១. ក្នុង proot Ubuntu បើកទាំងអស់ដោយបន្ទាត់តែមួយ៖{' '}
                <code className="text-cyan-300">sh phone-start.sh</code>
              </p>
              <p>
                ២. បើ API រត់រួចហើយ ហើយខ្វះតែ tunnel៖{' '}
                <code className="text-cyan-300">sh tunnel-cloudflared.sh</code>
              </p>
              <p>
                ៣. បើគេហទំព័រនិយាយថាបរាជ័យ តែការសាកល្បងក្នុងទូរស័ព្ទជោគជ័យ (API ជំនាន់ចាស់)៖{' '}
                <code className="text-cyan-300">sh restart-api.sh</code>
              </p>
              <p>៤. paste URL នោះក្នុងប្រអប់ខាងក្រោម (ជំនួសឈ្មោះចាស់)។</p>
              <p>៥. ចុច «រក្សាទុក និងសាកល្បង» — វារក្សាទុក URL នោះជាប់ ហើយផ្ញើសំឡេងសាកល្បងពិតៗទៅទូរស័ព្ទ។ ជោគជ័យ = គេហទំព័រប្រើវាភ្លាម។</p>
              <p>
                ៦. ការងារបកប្រែត្រូវការ Demucs នេះជាចាំបាច់ (គ្មានការជំនួសទេ) — ដូច្នេះពេល tunnel
                ប្តូរ URL ថ្មី គ្រាន់តែ paste ថ្មីម្តងទៀតនៅទីនេះ។
              </p>
            </div>
          </div>

          {connection && !connected && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-950/30 border border-amber-500/30">
              <TriangleAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-200 leading-relaxed">
                មិនទាន់ភ្ជាប់ Demucs API ទេ — ការងារបកប្រែនឹងឈប់នៅជំហានញែកភ្លេង ព្រោះប្រព័ន្ធមិនប្រើវិធីផ្សេងជំនួសទេ។
                (Stem separation needs the Demucs API; jobs stop at that step rather than using a substitute.)
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-cyan-400" />
              <span>URL របស់ Demucs API</span>
            </label>
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              readOnly={pinned}
              placeholder="https://xxxx.trycloudflare.com"
              className={`w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs border border-slate-800 placeholder:text-slate-600 focus:outline-none ${
                pinned
                  ? 'bg-slate-900/40 text-slate-400'
                  : 'bg-slate-900/60 text-slate-200 focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20'
              }`}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {!pinned && (
              <button
                type="button"
                onClick={handleSave}
                disabled={busy !== null || !url}
                className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
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
              បច្ចុប្បន្នកំពុងប្រើ <code className="text-slate-400">AUDIO_SEPARATOR_URL</code> ពី environment។
              ការរក្សាទុកខាងលើនឹងជំនួសវា។
            </p>
          )}

          {pinned && (
            <p className="text-[10px] text-cyan-200/80 leading-relaxed">
              URL នេះកំណត់ជាប់ក្នុងកូដកម្មវិធី (pinned) ដូច្នេះប្រព័ន្ធប្រើវាជាដាច់ខាត។
              មិនត្រូវការ API key ឬ model ទេ ព្រោះ Demucs API នៅលើទូរស័ព្ទមិនប្រើវា។
              បើត្រូវការប្តូរ URL សូមប្រាប់អ្នកអភិវឌ្ឍ។
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DemucsPanel;
