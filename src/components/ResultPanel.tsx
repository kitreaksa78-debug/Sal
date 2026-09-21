import React, { useState, useRef } from 'react';
import { 
  Download, 
  FileText, 
  Music, 
  CheckCircle2, 
  Subtitles, 
  RefreshCw, 
  Play, 
  Clock, 
  User 
} from 'lucide-react';
import { JobRecord } from '../types';
import { getDownloadUrl, getSubtitlesUrl, getAudioDownloadUrl } from '../lib/api';

interface ResultPanelProps {
  job: JobRecord;
  onReset: () => void;
}

export const ResultPanel: React.FC<ResultPanelProps> = ({ job, onReset }) => {
  const [showSubtitles, setShowSubtitles] = useState<boolean>(job.settings.subtitle ?? true);

  const dubbedVideoRef = useRef<HTMLVideoElement>(null);

  const finalVideoUrl = getDownloadUrl(job.id);
  const srtUrl = getSubtitlesUrl(job.id, 'srt');
  const vttUrl = getSubtitlesUrl(job.id, 'vtt');
  const audioUrl = getAudioDownloadUrl(job.id);

  const seekToTime = (seconds: number) => {
    if (dubbedVideoRef.current) {
      dubbedVideoRef.current.currentTime = seconds;
      dubbedVideoRef.current.play().catch(() => {});
    }
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = (secs % 60).toFixed(1);
    return `${mins}:${parseFloat(rem) < 10 ? '0' : ''}${rem}s`;
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
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono whitespace-nowrap">H.264/AAC</span>
              </h3>
            </div>

            <button
              type="button"
              onClick={() => setShowSubtitles(!showSubtitles)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                showSubtitles
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              <Subtitles className="w-3.5 h-3.5" />
              <span>អក្សររត់ {showSubtitles ? 'បើក' : 'បិទ'}</span>
            </button>
          </div>

          <div className="relative rounded-xl overflow-hidden bg-black aspect-video flex items-center justify-center border border-slate-800">
            <video
              ref={dubbedVideoRef}
              src={finalVideoUrl}
              controls
              playsInline
              className="w-full h-full object-contain"
            >
              {showSubtitles && (
                <track
                  kind="subtitles"
                  src={vttUrl}
                  srcLang="km"
                  label="Khmer"
                  default
                />
              )}
            </video>
          </div>
        </div>
      </div>

      {/* Action Download Buttons */}
      <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-5 shadow-xl">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
          ទាញយកលទ្ធផល (Download Outputs)
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Main Video Download */}
          <a
            href={finalVideoUrl}
            download={`khmer-dubbed-${job.id}.mp4`}
            className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold text-sm shadow-lg shadow-emerald-500/25 active:scale-95 transition-all min-h-[48px]"
          >
            <Download className="w-4 h-4" />
            <span>ទាញយក MP4 (Khmer Video)</span>
          </a>

          {/* Subtitle SRT */}
          <a
            href={srtUrl}
            download={`subtitles-${job.id}.srt`}
            className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 active:scale-95 transition-all min-h-[48px]"
          >
            <FileText className="w-4 h-4 text-emerald-400" />
            <span>ទាញយក Subtitles (SRT)</span>
          </a>

          {/* Subtitle VTT */}
          <a
            href={vttUrl}
            download={`subtitles-${job.id}.vtt`}
            className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 active:scale-95 transition-all min-h-[48px]"
          >
            <FileText className="w-4 h-4 text-teal-400" />
            <span>ទាញយក Subtitles (VTT)</span>
          </a>

          {/* Mixed Audio WAV */}
          <a
            href={audioUrl}
            download={`khmer-audio-${job.id}.wav`}
            className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 active:scale-95 transition-all min-h-[48px]"
          >
            <Music className="w-4 h-4 text-amber-400" />
            <span>ទាញយកសំឡេងខ្មែរ (WAV)</span>
          </a>
        </div>
      </div>

      {/* Interactive Dialogue Transcript & Timing Explorer */}
      {job.segments && job.segments.length > 0 && (
        <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-5 shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div className="min-w-0">
              <h3 className="text-xs sm:text-sm font-bold text-white flex flex-wrap items-center gap-2">
                <span>អត្ថបទសន្ទនា & ការបកប្រែ (Dialogue & Translation Transcript)</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 whitespace-nowrap">
                  {job.segments.length} បន្ទាត់
                </span>
              </h3>
              <p className="text-xs text-slate-300 mt-0.5">
                ចុចលើបន្ទាត់នីមួយៗដើម្បីស្វែងរក និងចាក់សំឡេងត្រង់វិនាទីនោះ
              </p>
            </div>
          </div>

          <div className="divide-y divide-slate-800/80 max-h-96 overflow-y-auto scroll-slim pr-1">
            {job.segments.map((seg, idx) => (
              <div
                key={seg.id || idx}
                onClick={() => seekToTime(seg.start)}
                className="py-3 px-3 rounded-xl hover:bg-slate-800/50 cursor-pointer transition-colors space-y-1.5 group"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="inline-flex items-center gap-1 font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                      <User className="w-3 h-3" />
                      <span>{seg.speaker}</span>
                      {seg.speakerGender && (
                        <span className="text-[10px] text-slate-400 capitalize">({seg.speakerGender})</span>
                      )}
                    </span>

                    {seg.emotion && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 capitalize whitespace-nowrap">
                        {seg.emotion}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 text-slate-300 font-mono group-hover:text-emerald-300 shrink-0">
                    <Clock className="w-3 h-3" />
                    <span>{formatTime(seg.start)} - {formatTime(seg.end)}</span>
                    <Play className="w-3 h-3 ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-emerald-400" />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {/* Original line */}
                  <div className="text-slate-300 italic">
                    <span className="text-[10px] font-bold text-slate-400 uppercase mr-1">EN:</span>
                    "{seg.text}"
                  </div>

                  {/* Translated Khmer line */}
                  <div className="text-emerald-300 font-medium font-sans">
                    <span className="text-[10px] font-bold text-emerald-400 uppercase mr-1">KM:</span>
                    "{seg.khmer || seg.text}"
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
