import React, { useRef } from 'react';
import { Download, CheckCircle2, RefreshCw } from 'lucide-react';
import { JobRecord } from '../types';
import { getDownloadUrl } from '../lib/api';

interface ResultPanelProps {
  job: JobRecord;
  onReset: () => void;
}

export const ResultPanel: React.FC<ResultPanelProps> = ({ job, onReset }) => {
  const dubbedVideoRef = useRef<HTMLVideoElement>(null);

  const finalVideoUrl = getDownloadUrl(job.id);

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
    </div>
  );
};
