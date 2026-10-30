import React, { useEffect, useRef, useState } from 'react';
import { Download, Loader2, RefreshCw, Square, Wand2 } from 'lucide-react';
import { JobRecord } from '../types';
import {
  cancelJob,
  createVoiceClone,
  getCloneDownloadUrl,
  getJob,
  subscribeToJobUpdates,
} from '../lib/api';

/**
 * «សំឡេងដូចដើម» — the Khmer words, restyled into the original singer's timbre.
 *
 * It sits under a finished Khmer version because that is where both halves
 * exist: the Khmer words with no music, and the original voice it was
 * separated from. The conversion runs on the server, so this screen only starts
 * it and follows the same progress stream as every other run.
 */
export const VoiceCloneCard: React.FC<{ job: JobRecord }> = ({ job }) => {
  const [clone, setClone] = useState<JobRecord | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopWatching = () => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopWatching, []);

  const watch = (initial: JobRecord) => {
    stopWatching();
    setClone(initial);

    unsubscribeRef.current = subscribeToJobUpdates(
      initial.id,
      (next) => {
        setClone(next);
        if (next.status === 'completed' || next.status === 'failed') stopWatching();
      },
      () => {
        if (pollRef.current) return;
        pollRef.current = setInterval(() => {
          getJob(initial.id)
            .then((next) => {
              setClone(next);
              if (next.status === 'completed' || next.status === 'failed') stopWatching();
            })
            .catch(() => {});
        }, 3000);
      }
    );
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      watch(await createVoiceClone(job.id));
    } catch (err: any) {
      setError(err?.message || 'មិនអាចចាប់ផ្តើមប្តូរសំឡេងបានទេ។');
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!clone) return;
    setCancelBusy(true);
    try {
      await cancelJob(clone.id);
    } catch {}
    finally {
      setCancelBusy(false);
    }
  };

  const running = Boolean(clone && clone.status !== 'completed' && clone.status !== 'failed');
  const done = clone?.status === 'completed';
  const failed = clone?.status === 'failed';

  return (
    <div className="rounded-xl border border-fuchsia-500/30 bg-fuchsia-950/20 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Wand2 className="w-4 h-4 text-fuchsia-300 shrink-0" />
        <div className="min-w-0">
          <h4 className="text-xs font-bold text-white leading-tight">សំឡេងដូចដើម (Voice clone)</h4>
          <p className="text-[10px] text-slate-400 leading-relaxed">
            ប្តូរសំឡេងខ្មែរ ឲ្យមាន timbre របស់អ្នកច្រៀងដើម — ពាក្យខ្មែរដដែល លើភ្លេងដើម។
          </p>
        </div>
      </div>

      {!clone && (
        <>
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-pink-500 hover:from-fuchsia-500 hover:to-pink-400 disabled:opacity-60 text-white font-semibold text-xs shadow-lg shadow-fuchsia-600/20 active:scale-95 transition-all min-h-[44px]"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            <span>{starting ? 'កំពុងចាប់ផ្តើម...' : 'ប្តូរទៅសំឡេងដើម'}</span>
          </button>
          {error && <p className="text-[11px] text-rose-300 leading-relaxed">{error}</p>}
        </>
      )}

      {running && clone && (
        <div className="space-y-2">
          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-fuchsia-500 to-pink-400 transition-all duration-500"
              style={{ width: `${Math.max(4, clone.progress)}%` }}
            />
          </div>
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] text-slate-300 flex items-start gap-1.5 leading-relaxed">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-fuchsia-300 shrink-0 mt-0.5" />
              {clone.khmerMessage || clone.message}
            </p>
            <button
              type="button"
              onClick={stop}
              disabled={cancelBusy}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-[11px] font-semibold text-slate-300 border border-slate-700 min-h-[36px] shrink-0"
            >
              <Square className="w-3 h-3" />
              បញ្ឈប់
            </button>
          </div>
        </div>
      )}

      {done && clone && (
        <div className="space-y-2.5">
          <audio
            src={getCloneDownloadUrl(clone.id, true)}
            controls
            preload="none"
            className="w-full h-10"
          />
          <a
            href={getCloneDownloadUrl(clone.id)}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-pink-500 hover:from-fuchsia-500 hover:to-pink-400 text-white font-semibold text-xs shadow-lg shadow-fuchsia-600/20 active:scale-95 transition-all min-h-[44px]"
          >
            <Download className="w-4 h-4" />
            <span>ទាញយក សំឡេងដូចដើម (MP3)</span>
          </a>
          {clone.clone && (
            <p className="text-[10px] text-slate-500">
              {clone.clone.chunks - clone.clone.chunksFailed}/{clone.clone.chunks} ផ្នែក ·{' '}
              {clone.clone.model}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              stopWatching();
              setClone(null);
            }}
            className="text-[11px] text-slate-400 underline"
          >
            សាកម្តងទៀត
          </button>
        </div>
      )}

      {failed && clone && (
        <div className="space-y-2">
          <p className="text-[11px] text-rose-300 leading-relaxed">{clone.error || clone.message}</p>
          <button
            type="button"
            onClick={() => {
              stopWatching();
              setClone(null);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-xs font-semibold text-slate-300 border border-slate-700 min-h-[40px]"
          >
            <RefreshCw className="w-4 h-4" />
            សាកល្បងម្តងទៀត
          </button>
        </div>
      )}
    </div>
  );
};
