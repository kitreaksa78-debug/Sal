import React from 'react';
import { CheckCircle2, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { JobRecord, JobStatus } from '../types';

interface ProcessingProgressProps {
  job: JobRecord;
  onRetry?: () => void;
}

interface StepItem {
  id: JobStatus | 'detect_transcribe';
  khmer: string;
  english: string;
  associatedStatuses: JobStatus[];
}

const PIPELINE_STAGES: StepItem[] = [
  {
    id: 'uploading',
    khmer: 'បញ្ចូលវីដេអូ',
    english: 'Upload video',
    associatedStatuses: ['uploading'],
  },
  {
    id: 'extracting_audio',
    khmer: 'ស្រង់សំឡេងចេញពីវីដេអូ',
    english: 'Audio extraction',
    associatedStatuses: ['extracting_audio'],
  },
  {
    id: 'separating_audio',
    khmer: 'ញែកសំឡេងមនុស្ស និងភ្លេង',
    english: 'Voice & music separation',
    associatedStatuses: ['separating_audio'],
  },
  {
    id: 'detect_transcribe',
    khmer: 'សម្គាល់អ្នកនិយាយ & ស្តាប់ពាក្យ',
    english: 'Speech detection & STT',
    associatedStatuses: ['transcribing', 'detecting_speakers'],
  },
  {
    id: 'translating',
    khmer: 'បកប្រែជាខ្មែរនិយាយបែបធម្មជាតិ',
    english: 'AI context translation',
    associatedStatuses: ['translating'],
  },
  {
    id: 'generating_voice',
    khmer: 'បង្កើតសំឡេងខ្មែរ AI',
    english: 'Khmer voice generation (TTS)',
    associatedStatuses: ['generating_voice'],
  },
  {
    id: 'syncing',
    khmer: 'តម្រឹមចង្វាក់ & ពេលវេលា',
    english: 'Audio synchronization',
    associatedStatuses: ['syncing'],
  },
  {
    id: 'mixing',
    khmer: 'បញ្ចូលសំឡេងជាមួយភ្លេងដើម',
    english: 'Intelligent audio mixing',
    associatedStatuses: ['mixing'],
  },
  {
    id: 'rendering',
    khmer: 'Render វីដេអូ MP4 ចុងក្រោយ',
    english: 'Final MP4 rendering',
    associatedStatuses: ['rendering', 'quality_check'],
  },
];

export const ProcessingProgress: React.FC<ProcessingProgressProps> = ({ job, onRetry }) => {
  const currentStatus = job.status;
  const isFailed = currentStatus === 'failed';
  const isCompleted = currentStatus === 'completed';

  // Determine stage state: 'completed' | 'active' | 'pending'
  const getStageState = (stage: StepItem): 'completed' | 'active' | 'pending' => {
    if (isCompleted) return 'completed';
    if (stage.associatedStatuses.includes(currentStatus)) return 'active';

    const currentStageIndex = PIPELINE_STAGES.findIndex(s => s.associatedStatuses.includes(currentStatus));
    const thisStageIndex = PIPELINE_STAGES.indexOf(stage);

    if (currentStageIndex > thisStageIndex) return 'completed';
    return 'pending';
  };

  // Generate ASCII-style bar [████████████░░░░]
  const renderAsciiBar = (pct: number) => {
    const totalBlocks = 20;
    const filledBlocks = Math.round((pct / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    return `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}]`;
  };

  return (
    <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-5 sm:p-7 shadow-2xl backdrop-blur-md space-y-6">
      {/* Header & Current Status Banner */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-semibold">
          {!isFailed && !isCompleted && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {isCompleted && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
          {isFailed && <AlertCircle className="w-3.5 h-3.5 text-rose-400" />}
          <span>
            {isCompleted
              ? 'ការបញ្ចូលសំឡេងរួចរាល់ (Dubbing Finished)'
              : isFailed
              ? 'ការដំណើរការបរាជ័យ (Processing Failed)'
              : 'ដំណើរការបកប្រែ និងបញ្ចូលសំឡេងខ្មែរ (Active Dubbing)'}
          </span>
        </div>

        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
          {job.khmerMessage || job.message}
        </h2>
        <p className="text-xs sm:text-sm text-slate-300 font-mono">
          {renderAsciiBar(job.progress)} <span className="font-bold text-emerald-400 ml-1">{job.progress}%</span>
        </p>
      </div>

      {/* Progress Bar Visual */}
      <div className="w-full bg-slate-800/80 rounded-full h-3 overflow-hidden p-0.5 border border-slate-700/50">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isFailed
              ? 'bg-rose-500'
              : 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 shadow-sm shadow-emerald-500/50'
          }`}
          style={{ width: `${Math.max(4, job.progress)}%` }}
        />
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

      {/* Error Card */}
      {isFailed && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs leading-relaxed space-y-3">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-sm text-rose-300">
                {job.error || 'មានបញ្ហាក្នុងការដំណើរការសំឡេង'}
              </div>
              <p className="mt-1 text-slate-300">
                មិនអាចដំណើរការសំឡេងក្នុងវីដេអូនេះបានទេ។ សូមសាកល្បងវីដេអូមួយផ្សេងទៀត ឬពិនិត្យការកំណត់សេវាកម្ម AI។
              </p>
            </div>
          </div>

          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-medium text-xs shadow-md transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>សាកល្បងម្តងទៀត (Try Again)</span>
            </button>
          )}
        </div>
      )}

      {/* Pipeline Stage Checklist */}
      <div className="space-y-2 border-t border-slate-800 pt-5">
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

                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">{stage.khmer}</div>
                  <div className="text-[10px] text-slate-400 truncate">{stage.english}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
