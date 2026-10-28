import React, { useRef, useState } from 'react';
import { Upload, FileAudio, FileVideo, CheckCircle2, Sparkles, ArrowRight, Mic, Music2 } from 'lucide-react';

interface UploadPanelProps {
  onFileSelect: (file: File) => void;
  selectedFile: File | null;
  previewUrl: string | null;
  videoDuration: number | null;
  videoResolution: { width: number; height: number } | null;
  onStart: () => void;
  isUploading: boolean;
  uploadProgress: number;
  /**
   * No Demucs service is connected. Separation is the whole product, so the
   * server refuses the upload — holding the button back here means the studio
   * says why before a file is picked, instead of after one has been sent.
   */
  startBlocked?: boolean;
}

/** Video and audio are both welcome: the separator only ever reads the sound. */
const ACCEPT = 'video/*,audio/*';
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i;

function looksLikeAudio(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_RE.test(file.name);
}

export const UploadPanel: React.FC<UploadPanelProps> = ({
  onFileSelect,
  selectedFile,
  previewUrl,
  videoDuration,
  videoResolution,
  onStart,
  isUploading,
  uploadProgress,
  startBlocked = false,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isAudio = selectedFile ? looksLikeAudio(selectedFile) : false;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
        onFileSelect(file);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelect(e.target.files[0]);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remSecs = Math.floor(secs % 60);
    return `${mins}:${remSecs < 10 ? '0' : ''}${remSecs}`;
  };

  return (
    <div className="space-y-6">
      {/* Upload Zone / Drop area */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        className={`relative overflow-hidden rounded-2xl border-2 border-dashed p-5 sm:p-10 text-center transition-all cursor-pointer select-none ${
          isDragOver
            ? 'border-emerald-400 bg-emerald-500/10 scale-[1.01]'
            : 'border-slate-700/80 bg-[#111827]/60 hover:border-emerald-500/50 hover:bg-[#111827]/90'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          onChange={handleFileChange}
          className="hidden"
          disabled={isUploading}
        />

        <div className="max-w-md mx-auto space-y-4">
          <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-tr from-emerald-600/30 to-teal-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center mx-auto shadow-inner">
            <Upload className="w-8 h-8 sm:w-10 sm:h-10 animate-bounce" />
          </div>

          <div>
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
              {selectedFile ? 'ប្តូរឯកសារថ្មី (Change File)' : 'បញ្ចូលឯកសារ (Upload)'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1.5 leading-relaxed">
              អូសនិងទម្លាក់វីដេអូ ឬឯកសារសំឡេង ឬចុចដើម្បីជ្រើសរើសពីទូរស័ព្ទ/កុំព្យូទ័រ
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              គាំទ្រ: MP4, MOV, WEBM, MP3, WAV, M4A • Max 500 MB
            </p>
          </div>

          <div className="pt-2">
            <button
              type="button"
              disabled={isUploading}
              className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-semibold text-sm shadow-lg shadow-emerald-600/25 active:scale-95 transition-all min-h-[48px] w-full sm:w-auto"
            >
              <Upload className="w-4 h-4" />
              <span>ជ្រើសរើសឯកសារ (Select File)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Selected File Metadata Preview Card */}
      {selectedFile && (
        <div className="p-4 sm:p-5 rounded-2xl bg-[#111827]/90 border border-emerald-500/30 shadow-lg space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                {isAudio ? <FileAudio className="w-5 h-5" /> : <FileVideo className="w-5 h-5" />}
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-white truncate max-w-xs sm:max-w-md">
                  {selectedFile.name}
                </h4>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 mt-0.5">
                  <span className="font-medium text-emerald-400">
                    {formatFileSize(selectedFile.size)}
                  </span>
                  {videoDuration && (
                    <>
                      <span>•</span>
                      <span>ថិរវេលា: {formatDuration(videoDuration)}</span>
                    </>
                  )}
                  {videoResolution && (
                    <>
                      <span>•</span>
                      <span>
                        កម្រិត: {videoResolution.width}x{videoResolution.height}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="w-full sm:w-auto space-y-2">
              <button
                type="button"
                onClick={onStart}
                disabled={isUploading || startBlocked}
                title={startBlocked ? 'ត្រូវភ្ជាប់ម៉ាស៊ីនញែកសំឡេង (Demucs) សិន' : undefined}
                className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold text-sm shadow-lg shadow-emerald-500/20 active:scale-95 transition-all flex items-center justify-center gap-2 min-h-[48px] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <Sparkles className="w-4 h-4" />
                <span>
                  {isUploading ? 'កំពុងផ្ទុកឡើង...' : 'ចាប់ផ្តើមញែកសំឡេង (Start Separating)'}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>

              {startBlocked && (
                <p className="text-[11px] text-amber-300 text-center sm:text-left">
                  ត្រូវភ្ជាប់ Demucs API សិន — បើគ្មានវា ការញែកសំឡេងមិនដំណើរការទេ។
                </p>
              )}
            </div>
          </div>

          {/* Upload Progress Bar if active */}
          {isUploading && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-slate-300">
                <span>កំពុងផ្ទុកឯកសារឡើងទៅកាន់ម៉ាស៊ីនបម្រើ...</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Preview: the picture plays when there is one, the sound always can. */}
          {previewUrl && (
            <div className="rounded-xl overflow-hidden bg-black/60 border border-slate-800/80 max-h-64 flex justify-center items-center">
              {isAudio ? (
                <audio src={previewUrl} controls className="w-full p-3" />
              ) : (
                <video src={previewUrl} controls className="max-h-64 w-auto object-contain rounded-lg" />
              )}
            </div>
          )}
        </div>
      )}

      {/* What comes out: the two tracks this studio hands back. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="p-4 rounded-xl bg-[#111827]/60 border border-slate-800 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
            <Mic className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>ទី ១ — បន្ទាត់សំឡេង (The Voice Track)</span>
          </div>
          <div className="text-xs text-slate-300 space-y-1.5 font-mono bg-slate-950/60 p-3 rounded-lg border border-slate-800/60">
            <div className="text-slate-400 font-sans font-semibold">
              ចេញពីឯកសារដើម ដោយគ្មានភ្លេងនៅក្រោម៖
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-emerald-400">
              <span className="min-w-0">├── សំឡេងនិយាយ (Speech / Dialogue)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 whitespace-nowrap">KEEP</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-teal-400">
              <span className="min-w-0">├── សំឡេងច្រៀង (Singing)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-300 whitespace-nowrap">KEEP</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-rose-400">
              <span className="min-w-0">└── ភ្លេង សំឡេងស៊ុប (Music &amp; SFX)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 whitespace-nowrap">REMOVED</span>
            </div>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#111827]/60 border border-slate-800 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
            <Music2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>ទី ២ — បន្ទាត់ភ្លេង (The Music Track)</span>
          </div>
          <div className="text-xs text-slate-300 space-y-1.5 font-mono bg-slate-950/60 p-3 rounded-lg border border-slate-800/60">
            <div className="text-slate-400 font-sans font-semibold">
              គ្រប់អ្វីដែលមិនមែនជាសំឡេងមនុស្ស៖
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-emerald-400">
              <span className="min-w-0">├── បទភ្លេង / វិញ្ញាតរន្ទះ (Instrumental)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 whitespace-nowrap">KEEP</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-teal-400">
              <span className="min-w-0">├── សំឡេងបរិយាកាស (Ambience)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-300 whitespace-nowrap">KEEP</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-rose-400">
              <span className="min-w-0">└── សំឡេងមនុស្ស (Human voice)</span>
              <span className="text-[10px] leading-5 px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 whitespace-nowrap">REMOVED</span>
            </div>
          </div>
        </div>
      </div>

      {/* The one-line promise, said plainly. */}
      <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-emerald-950/20 border border-emerald-500/25 text-xs text-slate-300 leading-relaxed">
        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <span>
          បញ្ចូលវីដេអូ ឬបទចម្រៀង → ទទួលបាន <b className="text-emerald-300">សំឡេង</b> (និយាយ និង
          ច្រៀង) និង <b className="text-emerald-300">ភ្លេង</b> ដាច់ដោយឡែកពីគ្នា ដោយឥតគិតថ្លៃ និងឥត
          ចុះឈ្មោះ។ បើបញ្ចូលវីដេអូ នឹងបានវីដេអូពីរទៀតដែលដាក់សំឡេងនីមួយៗលើរូបភាពដើម។
        </span>
      </div>
    </div>
  );
};

export default UploadPanel;
