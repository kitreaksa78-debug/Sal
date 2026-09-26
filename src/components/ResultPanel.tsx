import React, { useRef, useState } from 'react';
import { Download, CheckCircle2, RefreshCw, Captions, Copy, Check } from 'lucide-react';
import { JobRecord } from '../types';
import { getDownloadUrl } from '../lib/api';

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

export const ResultPanel: React.FC<ResultPanelProps> = ({ job, onReset }) => {
  const dubbedVideoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);

  const finalVideoUrl = getDownloadUrl(job.id);

  /** The Khmer lines of this video, oldest first — the text the dub speaks. */
  const lines = (job.segments || [])
    .map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: (segment.khmer || segment.text || '').trim(),
    }))
    .filter((line) => line.text.length > 0);

  const copyAllLines = async () => {
    try {
      await navigator.clipboard.writeText(lines.map((line) => line.text).join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard blocked (http, older phone): the text on screen stays selectable. */
    }
  };

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
              វីដេអូបកប្រែ និងបញ្ចូលសំឡេងរួចរាល់!
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              Khmer dubbed video rendered successfully in standard H.264/AAC MP4.
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
            <span>វីដេអូថ្មី</span>
          </button>
        </div>
      </div>

      {/* The dubbed result is the only player: the original video is already on
          the visitor's device, so playing it back here just adds noise. */}
      <div className="grid gap-5 grid-cols-1">
        {/* Dubbed Khmer Video Player */}
        <div className="bg-[#111827]/90 rounded-2xl border border-emerald-500/40 p-4 shadow-xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <h3 className="text-xs sm:text-sm font-bold text-white flex flex-wrap items-center gap-1.5">
                <span>វីដេអូសំឡេងខ្មែរ (Khmer Dubbed Video)</span>
              </h3>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
              <Captions className="w-3.5 h-3.5" />
              អក្សរខ្មែរបញ្ចូលក្នុងវីដេអូរួច
            </span>
          </div>

          <div className="relative rounded-xl overflow-hidden bg-black aspect-video flex items-center justify-center border border-slate-800">
            <video
              ref={dubbedVideoRef}
              src={finalVideoUrl}
              controls
              playsInline
              className="w-full h-full object-contain"
            />
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            អក្សរខ្មែរត្រូវបានបញ្ចូលទៅក្នុងវីដេអូនេះផ្ទាល់ ដូច្នេះវាលេចឡើងគ្រប់កម្មវិធី និងគ្រប់ទូរស័ព្ទ។
            (The Khmer subtitles are burned into this video, so they show in every player.)
          </p>
        </div>
      </div>

      {/* Action Download Buttons */}
      <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-5 shadow-xl">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
          ទាញយកលទ្ធផល (Download Outputs)
        </h3>

        <div className="grid grid-cols-1 gap-3">
          {/* Main Video Download */}
          <a
            href={finalVideoUrl}
            download={`khmer-dubbed-${job.id}.mp4`}
            className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold text-sm shadow-lg shadow-emerald-500/25 active:scale-95 transition-all min-h-[48px]"
          >
            <Download className="w-4 h-4" />
            <span>ទាញយក MP4 (Khmer Video)</span>
          </a>

        </div>
      </div>

      {/* The Khmer text itself: every line the dub speaks, in the order it is
          spoken. It replaces the old SRT/VTT buttons — the words live on screen
          where they can be read, selected and copied, instead of hiding inside a
          file the visitor has to open somewhere else. */}
      <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Captions className="w-4 h-4 text-emerald-400" />
            <span>
              អត្ថបទខ្មែរ (Khmer Text)
              {lines.length > 0 && (
                <span className="ml-1.5 font-normal normal-case text-slate-500">
                  {lines.length} បន្ទាត់
                </span>
              )}
            </span>
          </h3>

          {lines.length > 0 && (
            <button
              type="button"
              onClick={copyAllLines}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-[11px] font-semibold text-slate-300 transition-colors hover:bg-slate-700/80 hover:text-white min-h-[36px]"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-emerald-400" />
              )}
              {copied ? 'បានចម្លង' : 'ចម្លងអត្ថបទ'}
            </button>
          )}
        </div>

        {lines.length === 0 ? (
          <p className="text-xs text-slate-500 leading-relaxed">
            រូបវីដេអូនេះមិនមានបន្ទាត់អត្ថបទខ្មែរទេ។
          </p>
        ) : (
          <ol className="scroll-slim max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {lines.map((line, index) => (
              <li
                key={`${line.id}-${index}`}
                className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5"
              >
                <span className="mt-0.5 shrink-0 font-mono text-[10px] leading-5 text-slate-500 tabular-nums">
                  {formatClock(line.start)} → {formatClock(line.end)}
                </span>
                <span className="min-w-0 flex-1 text-xs leading-6 text-slate-200 sm:text-[13px]">
                  {line.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
};
