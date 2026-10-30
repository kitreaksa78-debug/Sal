import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileVideo,
  Languages,
  Loader2,
  Mic,
  Music2,
  RefreshCw,
  Sparkles,
  Square,
} from 'lucide-react';
import { JobRecord } from '../types';
import {
  cancelJob,
  createKhmerVersion,
  getJob,
  getKhmerDownloadUrl,
  getKhmerSpeechDownloadUrl,
  getStemDownloadUrl,
  subscribeToJobUpdates,
} from '../lib/api';

interface ResultPanelProps {
  job: JobRecord;
  onReset: () => void;
}

/** 00:12 — short enough to sit beside a line without stealing its width. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

interface StemCardProps {
  job: JobRecord;
  stem: 'vocals' | 'music';
  title: string;
  subtitle: string;
  description: string;
  icon: React.ReactNode;
  accent: string;
}

/**
 * One deliverable: its preview, its MP3 download, and — when the upload had a
 * picture — the same stem played over the original video.
 *
 * The preview is `inline`, so the browser plays it from this page while the
 * download button asks for the very same bytes as a file to keep.
 */
const StemCard: React.FC<StemCardProps> = ({
  job,
  stem,
  title,
  subtitle,
  description,
  icon,
  accent,
}) => {
  const audioUrl = getStemDownloadUrl(job.id, stem, 'mp3', true);
  const hasVideoTwin = Boolean(
    stem === 'vocals' ? job.vocalsVideoFile : job.musicVideoFile
  );

  return (
    <div className={`bg-[#111827]/90 rounded-2xl border p-4 shadow-xl space-y-3 ${accent}`}>
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-emerald-500/15 text-emerald-300 flex items-center justify-center shrink-0 border border-emerald-500/30">
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white leading-tight">{title}</h3>
          <p className="text-[11px] text-slate-400 truncate">{subtitle}</p>
        </div>
      </div>

      <p className="text-xs text-slate-300 leading-relaxed">{description}</p>

      {/* The sound itself, playable right here. */}
      <audio src={audioUrl} controls preload="none" className="w-full h-10" />

      <div className="flex flex-wrap gap-2">
        <a
          href={getStemDownloadUrl(job.id, stem, 'mp3')}
          className="flex-1 min-w-[150px] inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-semibold text-xs shadow-lg shadow-emerald-600/20 active:scale-95 transition-all min-h-[44px]"
        >
          <Download className="w-4 h-4" />
          <span>ទាញយក {title} (MP3)</span>
        </a>

        {hasVideoTwin && (
          <a
            href={getStemDownloadUrl(job.id, stem, 'mp4')}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 border border-slate-700 font-semibold text-xs transition-colors min-h-[44px]"
          >
            <FileVideo className="w-4 h-4" />
            <span>MP4</span>
          </a>
        )}
      </div>

      {hasVideoTwin && (
        <p className="text-[10px] text-slate-500 leading-relaxed">
          MP4 ដាក់បន្ទាត់នេះលើរូបភាពដើម — {formatClock(job.metadata?.duration || 0)} នាទី។
        </p>
      )}
    </div>
  );
};

/** The two Khmer voices the speech service offers for this language. */
const VOICE_CHOICES: { id: 'female' | 'male'; label: string; hint: string }[] = [
  { id: 'female', label: 'សំឡេងស្រី', hint: 'Sreymom' },
  { id: 'male', label: 'សំឡេងប្រុស', hint: 'Piseth' },
];

/**
 * «បកប្រែជាខ្មែរ» — the voice that was just pulled out of the song, sung again in
 * Khmer, over the music it came from.
 *
 * It lives on the result screen because it needs both halves of a finished
 * separation: the words are in the voice stem, the beat is in the music stem.
 * The new song is its own job, so its progress arrives over the same stream as a
 * separation and the visitor can stop it like any other run.
 */
const KhmerDubCard: React.FC<{ job: JobRecord }> = ({ job }) => {
  const [voice, setVoice] = useState<'female' | 'male'>('female');
  const [dub, setDub] = useState<JobRecord | null>(null);
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

  // Leaving the screen (or starting again) must not leave a stream open.
  useEffect(() => stopWatching, []);

  const watch = (initial: JobRecord) => {
    stopWatching();
    setDub(initial);

    unsubscribeRef.current = subscribeToJobUpdates(
      initial.id,
      (next) => {
        setDub(next);
        if (next.status === 'completed' || next.status === 'failed') stopWatching();
      },
      () => {
        // The stream dropped: fall back to asking, so the bar keeps moving.
        if (pollRef.current) return;
        pollRef.current = setInterval(() => {
          getJob(initial.id)
            .then((next) => {
              setDub(next);
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
      watch(await createKhmerVersion(job.id, voice));
    } catch (err: any) {
      setError(err?.message || 'មិនអាចចាប់ផ្តើមបង្កើតបទខ្មែរបានទេ។');
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!dub) return;
    setCancelBusy(true);
    try {
      await cancelJob(dub.id);
    } catch {}
    finally {
      setCancelBusy(false);
    }
  };

  const running = Boolean(dub && dub.status !== 'completed' && dub.status !== 'failed');
  const done = dub?.status === 'completed';
  const failed = dub?.status === 'failed';

  return (
    <div className="bg-[#111827]/90 rounded-2xl border border-violet-500/30 p-4 shadow-xl space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-violet-500/15 text-violet-300 flex items-center justify-center shrink-0 border border-violet-500/30">
          <Languages className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white leading-tight">
            បកប្រែជាខ្មែរ · បង្កើតបទថ្មី
          </h3>
          <p className="text-[11px] text-slate-400 truncate">
            សំឡេងដែលញែក → ខ្មែរ ដោយ Gemini · ច្រៀងលើភ្លេងដើម
          </p>
        </div>
      </div>

      <p className="text-xs text-slate-300 leading-relaxed">
        Gemini ស្តាប់សំឡេងច្រៀង/និយាយដែលបានញែក បកប្រែជាខ្មែរ រួចបង្កើតសំឡេងខ្មែរច្រៀងលើភ្លេងដើម —
        បានជាបទចម្រៀងថ្មីមួយ។
      </p>

      {!dub && (
        <>
          <div className="flex gap-1.5 p-1.5 rounded-xl bg-slate-900/70 border border-slate-800">
            {VOICE_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-pressed={voice === choice.id}
                onClick={() => setVoice(choice.id)}
                className={`flex-1 min-h-[40px] rounded-lg text-[11px] font-bold transition-colors ${
                  voice === choice.id
                    ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40'
                    : 'text-slate-400 border border-transparent hover:text-slate-200'
                }`}
              >
                {choice.label}
                <span className="block text-[9px] font-normal opacity-60">{choice.hint}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-500 hover:from-violet-500 hover:to-fuchsia-400 disabled:opacity-60 text-white font-semibold text-xs shadow-lg shadow-violet-600/20 active:scale-95 transition-all min-h-[44px]"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            <span>{starting ? 'កំពុងចាប់ផ្តើម...' : 'បកប្រែជាខ្មែរ និងបង្កើតបទថ្មី'}</span>
          </button>

          {error && <p className="text-[11px] text-rose-300 leading-relaxed">{error}</p>}
        </>
      )}

      {running && dub && (
        <div className="space-y-2">
          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-400 transition-all duration-500"
              style={{ width: `${Math.max(4, dub.progress)}%` }}
            />
          </div>
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] text-slate-300 flex items-start gap-1.5 leading-relaxed">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-300 shrink-0 mt-0.5" />
              {dub.khmerMessage || dub.message}
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

      {done && dub && (
        <div className="space-y-3">
          <audio
            src={getKhmerDownloadUrl(dub.id, 'mp3', true)}
            controls
            preload="none"
            className="w-full h-10"
          />

          <div className="flex flex-wrap gap-2">
            <a
              href={getKhmerDownloadUrl(dub.id, 'mp3')}
              className="flex-1 min-w-[170px] inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-500 hover:from-violet-500 hover:to-fuchsia-400 text-white font-semibold text-xs shadow-lg shadow-violet-600/20 active:scale-95 transition-all min-h-[44px]"
            >
              <Download className="w-4 h-4" />
              <span>ទាញយក បទខ្មែរ (MP3)</span>
            </a>

            {dub.khmerSpeechFile && (
              <a
                href={getKhmerSpeechDownloadUrl(dub.id)}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 border border-slate-700 font-semibold text-xs transition-colors min-h-[44px]"
                title="សម្រាប់ voice clone (មិនមានភ្លេង)"
              >
                <Download className="w-4 h-4" />
                <span>សំឡេងខ្មែរ (ឥតភ្លេង)</span>
              </a>
            )}

            {dub.khmerVideoFile && (
              <a
                href={getKhmerDownloadUrl(dub.id, 'mp4')}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 border border-slate-700 font-semibold text-xs transition-colors min-h-[44px]"
              >
                <FileVideo className="w-4 h-4" />
                <span>MP4</span>
              </a>
            )}
          </div>

          {dub.khmer && (
            <p className="text-[10px] text-slate-500">
              {dub.khmer.lines} បន្ទាត់ ·{' '}
              {VOICE_CHOICES.find((choice) => choice.id === dub.khmer!.voice)?.label} ·{' '}
              {dub.khmer.model}
            </p>
          )}

          {!!dub.segments?.length && (
            <details className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
              <summary className="text-[11px] font-semibold text-slate-300 cursor-pointer">
                បន្ទាត់ដែលបកប្រែ ({dub.segments.length})
              </summary>
              <ul className="mt-2 space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {dub.segments.slice(0, 60).map((segment) => (
                  <li key={segment.id} className="text-[11px] leading-relaxed">
                    <span className="text-slate-500">{formatClock(segment.start)}</span>{' '}
                    <span className="text-slate-100">{segment.khmer}</span>
                    {segment.text && (
                      <span className="block text-slate-500">{segment.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <button
            type="button"
            onClick={() => {
              stopWatching();
              setDub(null);
            }}
            className="text-[11px] text-slate-400 underline"
          >
            បង្កើតម្តងទៀត
          </button>
        </div>
      )}

      {failed && dub && (
        <div className="space-y-2">
          <p className="text-[11px] text-rose-300 leading-relaxed">{dub.error || dub.message}</p>
          <button
            type="button"
            onClick={() => {
              stopWatching();
              setDub(null);
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

export const ResultPanel: React.FC<ResultPanelProps> = ({ job, onReset }) => {
  const isVideo = job.inputKind !== 'audio';

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-emerald-950/40 via-teal-950/30 to-slate-900 p-4 sm:p-5 rounded-2xl border border-emerald-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3.5 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 border border-emerald-500/30 shadow-md">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base sm:text-xl font-bold text-white">
              ញែកសំឡេងរួចរាល់! (Separation Complete)
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              សំឡេង និងភ្លេង ត្រូវបានញែកដាច់ពីគ្នាហើយ —{' '}
              {isVideo ? 'ទាញយកជា MP3 ឬ MP4' : 'ទាញយកជា MP3'}
              {job.metadata?.duration ? ` · ${formatClock(job.metadata.duration)}` : ''}.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
          <button
            type="button"
            onClick={onReset}
            className="flex flex-1 sm:flex-none items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-xs font-semibold text-slate-300 border border-slate-700 transition-colors min-h-[44px]"
          >
            <RefreshCw className="w-4 h-4" />
            <span>ឯកសារថ្មី</span>
          </button>
        </div>
      </div>

      {/* The two tracks, side by side on a wide screen. */}
      <div className="grid gap-5 grid-cols-1 lg:grid-cols-2">
        <StemCard
          job={job}
          stem="vocals"
          title="សំឡេង (Voice)"
          subtitle="សំឡេងនិយាយ និងសំឡេងច្រៀង · គ្មានភ្លេង"
          description="អ្វីដែលមនុស្សនិយាយ និងច្រៀង ដោយគ្មានបទភ្លេង ឬសំឡេងស៊ុបនៅក្រោមោះ — សម្រាប់យកទៅប្រើឡើងវិញ ឬស្តាប់តែសំឡេង។"
          icon={<Mic className="w-5 h-5" />}
          accent="border-emerald-500/40"
        />

        <StemCard
          job={job}
          stem="music"
          title="ភ្លេង (Music)"
          subtitle="បទភ្លេង សំឡេងបរិយាកាស · គ្មានសំឡេងមនុស្ស"
          description="គ្រប់អ្វីដែលមិនមែនជាសំឡេងមនុស្ស — បទភ្លេង សំឡេងស៊ុប និងបរិយាកាស ដោយសំឡេងនិយាយ និងច្រៀងត្រូវបានដកចេញ។"
          icon={<Music2 className="w-5 h-5" />}
          accent="border-teal-500/30"
        />
      </div>

      {/* The voice that was just separated, sung again in Khmer. */}
      <KhmerDubCard job={job} />

      {/* The picture twin, played where there is one. */}
      {isVideo && (job.vocalsVideoFile || job.musicVideoFile) && (
        <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 shadow-xl space-y-3">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            មើលលើរូបភាពដើម (Watch it over the original picture)
          </h3>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
            {job.vocalsVideoFile && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-slate-400">តែសំឡេង — រូបភាពដើម</p>
                <video
                  src={getStemDownloadUrl(job.id, 'vocals', 'mp4', true)}
                  controls
                  playsInline
                  className="w-full rounded-xl bg-black border border-slate-800"
                />
              </div>
            )}
            {job.musicVideoFile && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-slate-400">តែភ្លេង — រូបភាពដើម</p>
                <video
                  src={getStemDownloadUrl(job.id, 'music', 'mp4', true)}
                  controls
                  playsInline
                  className="w-full rounded-xl bg-black border border-slate-800"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ResultPanel;
