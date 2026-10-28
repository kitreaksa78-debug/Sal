import React, { useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, RefreshCw, XCircle } from 'lucide-react';
import { JobRecord, JobStatus } from '../types';
import { cancelJob } from '../lib/api';

interface ProcessingProgressProps {
  job: JobRecord;
  onRetry?: () => void;
}

interface StepItem {
  id: JobStatus;
  khmer: string;
  english: string;
  associatedStatuses: JobStatus[];
}

/**
 * The pipeline the studio actually runs, in order:
 *
 *   Upload File → Read the audio → Separate voice from music → Downloads
 *
 * Four rows, one per stage: the Khmer line names what the stage does, the line
 * under it names the engine that does it. Each row owns every status the server
 * reports inside that step, which is what keeps the checklist lighting up from
 * top to bottom as the job moves.
 *
 * Separation is a Demucs model running on the phone or Colab GPU the panel is
 * pointed at — it is the only thing that can genuinely lift a voice out of a
 * mix — and FFmpeg does the rest on this server: it reads the audio track out
 * of whatever was uploaded and encodes the two stems as the MP3s that get
 * downloaded. `failed` is deliberately owned by no row: a run that died must not
 * light the whole list up green.
 */
const PIPELINE_STAGES: StepItem[] = [
  {
    id: 'uploading',
    khmer: 'អ្នកប្រើបញ្ចូលឯកសារ',
    english: 'Upload File',
    associatedStatuses: ['uploading'],
  },
  {
    id: 'extracting_audio',
    khmer: 'អានបន្ទាត់សំឡេងពីឯកសារ',
    english: 'Extract Audio (FFmpeg)',
    associatedStatuses: ['extracting_audio'],
  },
  {
    id: 'separating_audio',
    khmer: 'ញែកសំឡេងនិយាយ និងសំឡេងច្រៀងចេញពីភ្លេង',
    english: 'Demucs (voice / music)',
    associatedStatuses: ['separating_audio'],
  },
  {
    id: 'mixing',
    khmer: 'បម្លែង និងរៀបចំឯកសារទាញយក',
    english: 'Encode MP3 + video twin',
    associatedStatuses: ['mixing', 'rendering', 'quality_check'],
  },
];

/**
 * The one place the studio explains which engine is behind the checklist, said
 * under the list so it travels with what it describes.
 */
const ENGINE_NOTE =
  'ការញែកសំឡេងប្រើម៉ូដែល Demucs ដែលរត់នៅលើ GPU (Colab / ទូរស័ព្ទ) ដែលកាត «ញែកភ្លេង» ភ្ជាប់ទៅ រួច FFmpeg លើម៉ាស៊ីននេះអានបន្ទាត់សំឡេង និងបម្លែងសំឡេងដែលបានញែកទៅជាឯកសារ MP3 គុណភាពខ្ពស់។ (Voices are split by the Demucs model on the GPU the stem panel points at; FFmpeg on this server reads the audio track and encodes the results as high-quality MP3s.)';

export const ProcessingProgress: React.FC<ProcessingProgressProps> = ({ job, onRetry }) => {
  const currentStatus = job.status;
  const isFailed = currentStatus === 'failed';
  const isCompleted = currentStatus === 'completed';
  // The stop request is sent once; until the pipeline reaches its next
  // checkpoint the button stays disabled instead of looking broken.
  const [cancelling, setCancelling] = useState(false);
  const cancelPending = cancelling || Boolean(job.cancelRequested && !isFailed && !isCompleted);

  const handleCancel = async () => {
    if (
      !window.confirm(
        'បោះបង់ការងារនេះ?\n\nឯកសារដែលកំពុងដំណើរការនឹងឈប់ ហើយមិនទទួលបានលទ្ធផលទេ។'
      )
    ) {
      return;
    }
    setCancelling(true);
    try {
      await cancelJob(job.id);
    } catch (err: any) {
      alert(err?.message || 'មិនអាចបោះបង់ការងារនេះបានទេ');
      setCancelling(false);
    }
    // On success the server keeps the flag and the SSE stream reports the
    // final cancelled state, which clears this button by itself.
  };

  // Determine stage state: 'completed' | 'active' | 'pending'
  const getStageState = (stage: StepItem): 'completed' | 'active' | 'pending' => {
    if (isCompleted) return 'completed';
    if (stage.associatedStatuses.includes(currentStatus)) return 'active';

    const currentStageIndex = PIPELINE_STAGES.findIndex(s =>
      s.associatedStatuses.includes(currentStatus)
    );

    // Every current status the server reports is owned by a row, so the only
    // status left here is `queued` (nothing has started) or a legacy dubbing
    // status from a job recorded before this studio separated stems.
    if (currentStageIndex === -1) return 'pending';

    const thisStageIndex = PIPELINE_STAGES.indexOf(stage);
    if (currentStageIndex > thisStageIndex) return 'completed';
    return 'pending';
  };

  /** Overall progress, clamped: one number drives the bar below. */
  const progressPct = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));

  return (
    <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-7 shadow-2xl backdrop-blur-md space-y-5 sm:space-y-6">
      {/* Header & Current Status Banner */}
      <div className="text-center space-y-2">
        <div className="flex flex-col items-center gap-3">
          <div className="inline-flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px] sm:text-xs font-semibold text-center">
            {!isFailed && !isCompleted && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isCompleted && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
            {isFailed && <AlertCircle className="w-3.5 h-3.5 text-rose-400" />}
            <span>
              {isCompleted
                ? 'ការញែកសំឡេងរួចរាល់ (Separation Finished)'
                : isFailed
                ? job.cancelled
                  ? 'បានបោះបង់ (Cancelled)'
                  : 'ការដំណើរការបរាជ័យ (Processing Failed)'
                : cancelPending
                ? 'កំពុងបោះបង់... (Cancelling)'
                : 'កំពុងញែកសំឡេង (Separating Voice from Music)'}
            </span>
          </div>

          {/* Stop the run: the pipeline checks the flag between steps. */}
          {!isFailed && !isCompleted && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900/70 hover:bg-rose-500/15 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40 text-xs font-semibold transition-colors min-h-[40px] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {cancelPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <XCircle className="w-4 h-4" />
              )}
              <span>{cancelPending ? 'កំពុងបោះបង់…' : 'បោះបង់ (Cancel)'}</span>
            </button>
          )}
        </div>

        <h2 className="text-lg sm:text-2xl font-bold text-white tracking-tight">
          {job.khmerMessage || job.message}
        </h2>
      </div>

      {/* One number, one bar — both read the same job.progress, so they can never
          disagree the way the old ASCII bar did on a phone's font. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 text-[11px] sm:text-xs text-slate-400">
          <span>ការរីកចម្រើនសរុប (Overall progress)</span>
          <span className="font-bold text-emerald-400">{progressPct}%</span>
        </div>
        <div className="w-full bg-slate-800/80 rounded-full h-3 overflow-hidden p-0.5 border border-slate-700/50">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              isFailed
                ? 'bg-rose-500'
                : 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 shadow-sm shadow-emerald-500/50'
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Warning Notice if partial separation occurred */}
      {job.warning && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs leading-relaxed flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">ចំណាំប្រព័ន្ធ: </span>
            {job.warning}
          </div>
        </div>
      )}

      {/* Error Card — a cancelled run is a decision, not a failure to investigate */}
      {isFailed && (
        <div
          className={`p-4 rounded-xl text-xs leading-relaxed space-y-3 border ${
            job.cancelled
              ? 'bg-slate-900/70 border-slate-700 text-slate-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {job.cancelled ? (
              <XCircle className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            )}
            <div>
              <div
                className={`font-bold text-sm ${job.cancelled ? 'text-slate-200' : 'text-rose-300'}`}
              >
                {job.cancelled
                  ? 'បានបោះបង់ការងារនេះរួច (Job Cancelled)'
                  : job.error || 'មានបញ្ហាក្នុងការញែកសំឡេង'}
              </div>
              {!job.cancelled && (
                <p className="mt-1 text-slate-300">
                  សូមពិនិត្យការតភ្ជាប់ទៅម៉ាស៊ីនញែកភ្លេង (Demucs API) ក្នុងផ្ទាំង «ញែកភ្លេង»
                  រួចសាកល្បងម្តងទៀត។
                </p>
              )}
              {job.cancelled && (
                <p className="mt-1 text-slate-400">
                  ឯកសារផ្ទៃខាងក្រោយត្រូវបានសម្អាត។ សូមបញ្ចូលឯកសារឡើងវិញ ដើម្បីចាប់ផ្តើមថ្មី។
                </p>
              )}
            </div>
          </div>

          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white font-medium text-xs shadow-md transition-colors ${
                job.cancelled
                  ? 'bg-slate-700 hover:bg-slate-600'
                  : 'bg-rose-600 hover:bg-rose-500'
              }`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{job.cancelled ? 'បញ្ចូលឯកសារថ្មី (New File)' : 'សាកល្បងម្តងទៀត (Try Again)'}</span>
            </button>
          )}
        </div>
      )}

      {/* Pipeline Stage Checklist */}
      <div className="space-y-2 border-t border-slate-800 pt-4 sm:pt-5">
        <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
          ដំណាក់កាលដំណើរការ (Processing Stages)
        </h4>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {PIPELINE_STAGES.map((stage) => {
            const state = getStageState(stage);
            return (
              <div
                key={stage.id}
                className={`flex items-center gap-3 p-2.5 rounded-xl border transition-all ${
                  state === 'completed'
                    ? 'bg-emerald-500/5 border-emerald-500/20 text-slate-200'
                    : state === 'active'
                    ? 'bg-teal-500/10 border-teal-500/40 text-white shadow-sm ring-1 ring-teal-500/30'
                    : 'bg-slate-900/30 border-slate-800/60 text-slate-400 opacity-60'
                }`}
              >
                <div className="shrink-0 flex items-center justify-center">
                  {state === 'completed' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  )}
                  {state === 'active' && (
                    <Loader2 className="w-4 h-4 text-teal-400 animate-spin" />
                  )}
                  {state === 'pending' && (
                    <div className="w-3.5 h-3.5 rounded-full border border-slate-600" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold leading-snug">{stage.khmer}</div>
                  <div className="text-[10px] text-slate-400 truncate">{stage.english}</div>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[10px] sm:text-[11px] text-slate-500 leading-relaxed pt-1">
          {ENGINE_NOTE}
        </p>
      </div>
    </div>
  );
};
