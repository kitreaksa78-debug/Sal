import React from 'react';
import { Download, CheckCircle2, RefreshCw, Mic, Music2, FileVideo } from 'lucide-react';
import { JobRecord } from '../types';
import { getStemDownloadUrl } from '../lib/api';

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
