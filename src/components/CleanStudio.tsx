import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileVideo,
  Loader2,
  Mic,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
  UploadCloud,
  Wand2,
  X,
} from 'lucide-react';
import { JobRecord } from '../types';
import {
  cancelJob,
  getCleanDownloadUrl,
  getGeminiSettings,
  getJob,
  getOriginalDownloadUrl,
  subscribeToJobUpdates,
  uploadCleanupJob,
} from '../lib/api';

/**
 * The stages of a cleanup, in the order the server reports them. `queued` is
 * folded into the first row: from the visitor's side "waiting" and "reading the
 * audio" are the same silent minute.
 */
const STEPS: { statuses: JobRecord['status'][]; km: string; en: string }[] = [
  {
    statuses: ['queued', 'extracting_audio'],
    km: 'អានបន្ទាត់សំឡេងពីឯកសារ',
    en: 'Read the audio',
  },
  {
    statuses: ['analyzing_audio'],
    km: 'Gemini ស្តាប់ និងរកសំឡេងរំខាន',
    en: 'Gemini listens',
  },
  {
    statuses: ['cleaning_audio'],
    km: 'កាត់សំឡេងរំខានចេញ និងសម្អាត',
    en: 'Cut noise & denoise',
  },
  {
    statuses: ['mixing'],
    km: 'បម្លែងឯកសារស្អាត',
    en: 'Encode',
  },
];

const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|opus|flac|aiff?|wma)$/i;
const isAudioFile = (file: File) =>
  file.type.startsWith('audio/') || (!file.type.startsWith('video/') && AUDIO_RE.test(file.name));

/** 01:07 — matches the clocks the rest of the studio uses. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * «សម្អាតសំឡេង» — upload a vocal take, keep only the clean voice.
 *
 * Separate from the stem separator on purpose: the visitor here is not pulling a
 * voice out of a mix, they are cleaning the voice they already have. Gemini
 * listens and says which stretches are noise; FFmpeg cuts them out and denoises
 * what is left. The result screen plays the original and the cleaned take next
 * to each other, because "is it better?" can only be answered by ear.
 */
export const CleanStudio: React.FC = () => {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [audioOnly, setAudioOnly] = useState(true);
  const [dragging, setDragging] = useState(false);

  const [job, setJob] = useState<JobRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The cleanup runs on the deployment's own Gemini keys — there is nothing to
   * configure from the browser. The studio only asks whether a key exists, so a
   * missing one is explained before a file is uploaded instead of after.
   */
  useEffect(() => {
    let cancelled = false;

    getGeminiSettings()
      .then((settings) => {
        if (!cancelled) setConfigured(settings.configured);
      })
      .catch(() => {
        if (!cancelled) setConfigured(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const inputRef = useRef<HTMLInputElement | null>(null);
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

  /** Live progress: SSE when it connects, a 2.5s poll when it does not. */
  useEffect(() => {
    if (!job) return;
    if (job.status === 'completed' || job.status === 'failed') {
      stopWatching();
      return;
    }

    const jobId = job.id;
    stopWatching();

    const poll = () => {
      if (pollRef.current) return;
      pollRef.current = setInterval(async () => {
        try {
          const fresh = await getJob(jobId);
          setJob(fresh);
          if (fresh.status === 'completed' || fresh.status === 'failed') {
            stopWatching();
          }
        } catch {}
      }, 2500);
    };

    unsubscribeRef.current = subscribeToJobUpdates(
      jobId,
      (updated) => {
        setJob(updated);
        if (updated.status === 'completed' || updated.status === 'failed') stopWatching();
      },
      poll
    );

    return stopWatching;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  useEffect(() => {
    return () => {
      stopWatching();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const pickFile = (next: File) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setError(null);

    const objectUrl = URL.createObjectURL(next);
    setFile(next);
    setPreviewUrl(objectUrl);
    setDuration(null);

    if (isAudioFile(next)) {
      setAudioOnly(true);
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.src = objectUrl;
      audio.onloadedmetadata = () => {
        setDuration(Number.isFinite(audio.duration) ? audio.duration : null);
      };
      return;
    }

    setAudioOnly(false);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = objectUrl;
    video.onloadedmetadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : null);
    };
  };

  const handleStart = async () => {
    if (!file) return;
    if (configured === false) {
      setError('មិនទាន់មាន Gemini key ទេ។ បញ្ចូល key ក្នុងផ្ទាំងខាងលើសិន។');
      return;
    }

    setError(null);
    setUploading(true);
    setUploadPct(0);

    try {
      const result = await uploadCleanupJob(file, (pct) => setUploadPct(pct));
      setJob(result.job);
    } catch (err: any) {
      setError(err?.message || 'ការបញ្ចូលឯកសារបរាជ័យ។');
    } finally {
      setUploading(false);
    }
  };

  const handleCancel = async () => {
    if (!job) return;
    setCancelBusy(true);
    try {
      await cancelJob(job.id);
      setJob(await getJob(job.id));
    } catch (err: any) {
      setError(err?.message || 'មិនអាចបោះបង់បានទេ។');
    } finally {
      setCancelBusy(false);
    }
  };

  const handleReset = () => {
    stopWatching();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setDuration(null);
    setJob(null);
    setError(null);
    setUploadPct(0);
  };

  const stepIndex = (status: JobRecord['status']) =>
    STEPS.findIndex((step) => step.statuses.includes(status));

  const busy = Boolean(job) && job!.status !== 'completed' && job!.status !== 'failed';

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-xs leading-relaxed flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {configured === false && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs leading-relaxed flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            ម៉ាស៊ីនមេមិនទាន់មាន Gemini key ទេ — ការសម្អាតសំឡេងមិនអាចដំណើរការបានរហូតដល់មាន key។
          </p>
        </div>
      )}

      {/* ------------------------------------------------------- upload */}
      {!job && (
        <section className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-5 space-y-4 shadow-xl">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Wand2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white leading-tight">
                សម្អាតសំឡេង — យកតែសំឡេងស្អាត
              </h2>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                បញ្ចូលឯកសារច្រៀង ឬសំឡេងនិយាយ។ Gemini ស្តាប់រកកន្លែងដែលមានសំឡេងរំខាន (សំឡេងហ៊ឹស
                សំឡេងទូរទឹកកក ខ្យល់ ម៉ូតូ កៅអី) ហើយប្រព័ន្ធកាត់ចេញ ព្រមទាំងបន្ថយសំឡេងរអាក់រអួល
                ដោយរក្សាសំឡេងមនុស្សដើម។
              </p>
            </div>
          </div>

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const dropped = event.dataTransfer.files?.[0];
              if (dropped) pickFile(dropped);
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
            }}
            className={`rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
              dragging
                ? 'border-emerald-400/70 bg-emerald-500/10'
                : 'border-slate-700 bg-slate-900/40 hover:border-emerald-500/50 hover:bg-slate-900/70'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.mp4,.mov,.webm"
              className="hidden"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) pickFile(chosen);
                event.target.value = '';
              }}
            />
            <UploadCloud className="w-8 h-8 mx-auto text-emerald-400/80" />
            <p className="mt-2 text-sm font-semibold text-slate-100">
              {file ? file.name : 'ចុចដើម្បីជ្រើសឯកសារ ឬអូសទម្លាក់ទីនេះ'}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              MP3 · WAV · M4A · AAC · OGG · FLAC — ឬវីដេអូ (MP4/MOV/WEBM) ដើម្បីសម្អាតសំឡេងក្នុងវីដេអូ
            </p>
            {file && duration ? (
              <p className="text-[10px] text-slate-500 mt-1">
                {formatClock(duration)} · {(file.size / (1024 * 1024)).toFixed(1)} MB
              </p>
            ) : null}
          </div>

          {file && previewUrl && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-slate-300">ស្តាប់មុនសម្អាត</p>
                <button
                  type="button"
                  onClick={() => {
                    URL.revokeObjectURL(previewUrl);
                    setFile(null);
                    setPreviewUrl(null);
                    setDuration(null);
                  }}
                  className="text-[11px] text-slate-400 hover:text-red-300 flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> លុបចេញ
                </button>
              </div>
              {audioOnly ? (
                <audio src={previewUrl} controls className="w-full h-10" />
              ) : (
                <video src={previewUrl} controls playsInline className="w-full rounded-xl bg-black border border-slate-800 max-h-72" />
              )}
            </div>
          )}

          <button
            type="button"
            onClick={handleStart}
            disabled={!file || uploading || configured === false}
            className="w-full min-h-[48px] px-5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm shadow-lg shadow-emerald-600/20 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
          >
            {uploading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                កំពុងបញ្ចូល... {uploadPct}%
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                ចាប់ផ្តើមសម្អាតសំឡេង
              </>
            )}
          </button>
        </section>
      )}

      {/* ----------------------------------------------------- progress */}
      {job && busy && (
        <section className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Loader2 className="w-5 h-5 text-emerald-400 animate-spin shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">
                  កំពុងសម្អាតសំឡេង...
                </p>
                <p className="text-[11px] text-slate-400 truncate">{job.originalFilename}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelBusy}
              className="shrink-0 min-h-[40px] px-3 rounded-xl text-[11px] font-semibold bg-slate-800/80 text-slate-300 border border-slate-700 hover:border-red-500/40 hover:text-red-300 disabled:opacity-50 flex items-center gap-1.5"
            >
              {cancelBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
              បញ្ឈប់
            </button>
          </div>

          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500"
              style={{ width: `${Math.max(4, Math.min(100, job.progress || 0))}%` }}
            />
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">{job.khmerMessage || job.message}</p>

          <ol className="space-y-1.5">
            {STEPS.map((step, index) => {
              const current = stepIndex(job.status);
              const done = current > index;
              const active = current === index;
              return (
                <li
                  key={step.en}
                  className={`flex items-center gap-2 text-[11px] ${
                    done ? 'text-emerald-300' : active ? 'text-white' : 'text-slate-500'
                  }`}
                >
                  {done ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  ) : active ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  ) : (
                    <span className="w-3.5 h-3.5 rounded-full border border-slate-700 shrink-0" />
                  )}
                  <span className="truncate">{step.km}</span>
                  <span className="text-slate-600 text-[10px] hidden sm:inline">· {step.en}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* ------------------------------------------------------ failure */}
      {job && job.status === 'failed' && (
        <section className="bg-red-500/10 rounded-2xl border border-red-500/30 p-4 sm:p-5 space-y-3">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-bold text-red-200">
                {job.cancelled ? 'បានបញ្ឈប់ការងារ' : 'ការសម្អាតសំឡេងបរាជ័យ'}
              </h2>
              <p className="text-xs text-red-100/90 mt-1 leading-relaxed">{job.error || job.message}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-slate-800/80 text-slate-200 border border-slate-700 hover:border-slate-500 transition-colors flex items-center justify-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            សាកល្បងឯកសារថ្មី
          </button>
        </section>
      )}

      {/* ------------------------------------------------------- result */}
      {job && job.status === 'completed' && (
        <section className="space-y-4">
          <div className="bg-gradient-to-r from-emerald-950/40 via-teal-950/30 to-slate-900 p-4 sm:p-5 rounded-2xl border border-emerald-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start sm:items-center gap-3.5 min-w-0">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 border border-emerald-500/30">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base sm:text-xl font-bold text-white">សំឡេងស្អាតរួចរាល់!</h2>
                <p className="text-xs text-slate-300 mt-0.5">
                  ស្តាប់ប្រៀបធៀបមុន/ក្រោយ រួចទាញយកសំឡេងដែលបានសម្អាត។
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-xs font-semibold text-slate-300 border border-slate-700 transition-colors min-h-[44px] shrink-0"
            >
              <RefreshCw className="w-4 h-4" />
              ឯកសារថ្មី
            </button>
          </div>

          <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
            <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-slate-400" />
                <h3 className="text-xs font-bold text-slate-200">មុនសម្អាត (ដើម)</h3>
              </div>
              <audio src={getOriginalDownloadUrl(job.id, true)} controls preload="none" className="w-full h-10" />
              <p className="text-[10px] text-slate-500">ឯកសារដែលអ្នកបញ្ចូល — មានសំឡេងរំខានដើម។</p>
            </div>

            <div className="bg-[#111827]/90 rounded-2xl border border-emerald-500/40 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Scissors className="w-4 h-4 text-emerald-300" />
                <h3 className="text-xs font-bold text-emerald-200">ក្រោយសម្អាត (សំឡេងស្អាត)</h3>
              </div>
              <audio src={getCleanDownloadUrl(job.id, 'mp3', true)} controls preload="none" className="w-full h-10" />
              <div className="flex flex-wrap gap-2 pt-1">
                <a
                  href={getCleanDownloadUrl(job.id, 'mp3')}
                  className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-semibold text-xs shadow-lg shadow-emerald-600/20 active:scale-95 transition-all min-h-[44px]"
                >
                  <Download className="w-4 h-4" />
                  ទាញយក MP3
                </a>
                {job.cleanVideoFile && (
                  <a
                    href={getCleanDownloadUrl(job.id, 'mp4')}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 border border-slate-700 font-semibold text-xs transition-colors min-h-[44px]"
                  >
                    <FileVideo className="w-4 h-4" />
                    MP4
                  </a>
                )}
              </div>
            </div>
          </div>

          {job.cleanVideoFile && (
            <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 space-y-2">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                វីដេអូជាមួយសំឡេងស្អាត
              </h3>
              <video
                src={getCleanDownloadUrl(job.id, 'mp4', true)}
                controls
                playsInline
                className="w-full rounded-xl bg-black border border-slate-800"
              />
            </div>
          )}

          {job.cleanup && (
            <div className="bg-[#0d1420]/90 rounded-2xl border border-slate-800 p-4 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                របាយការណ៍សម្អាត
              </p>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-200 border border-emerald-500/25">
                  កាត់ចេញ {job.cleanup.spansRemoved} កន្លែង
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-slate-900/70 text-slate-300 border border-slate-800">
                  {job.cleanup.removedSeconds.toFixed(1)} វិនាទី ត្រូវបានដក
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-slate-900/70 text-slate-300 border border-slate-800">
                  {formatClock(job.cleanup.originalSeconds)} ដើម
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-violet-500/10 text-violet-200 border border-violet-500/25">
                  {job.cleanup.model} · {job.cleanup.keyLabel}
                </span>
                {job.cleanup.chunksFailed > 0 && (
                  <span className="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-200 border border-amber-500/25">
                    {job.cleanup.chunksFailed}/{job.cleanup.chunks} ផ្នែកអានមិនបាន
                  </span>
                )}
              </div>
              <p className="text-[10px] text-slate-500 leading-relaxed">
                Gemini ស្តាប់ឯកសារជា {job.cleanup.chunks} ផ្នែក។ ចំណុចដែលមានសំឡេងមនុស្សមិនត្រូវបានកាត់ទេ
                — មានតែផ្នែកដែលគ្មានសំឡេងមនុស្សប៉ុណ្ណោះ ហើយប្រព័ន្ធកំណត់មិនឲ្យកាត់លើស ៤០% នៃឯកសារ។
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default CleanStudio;
