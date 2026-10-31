import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, AudioLines, Sparkles } from 'lucide-react';
import { Header } from './components/Header';
import { CleanStudio } from './components/CleanStudio';
import { UploadPanel } from './components/UploadPanel';
import { ProcessingProgress } from './components/ProcessingProgress';
import { ResultPanel } from './components/ResultPanel';
import { DemucsPanel } from './components/DemucsPanel';
import { VoiceCloneApiPanel } from './components/VoiceCloneApiPanel';
import { JobRecord } from './types';
import {
  uploadSeparationJob,
  getJob,
  subscribeToJobUpdates,
  getSystemConfigStatus,
} from './lib/api';
import { useLiveStatus } from './lib/liveStatus';

/**
 * Shown when the status endpoint reports no stem service and sent no reason of
 * its own — the same rule the server enforces, in the studio's own words.
 */
const DEMUCS_REQUIRED_NOTICE =
  'បើគ្មានម៉ាស៊ីនញែកភ្លេង (Demucs) ទេ ការញែកសំឡេងមិនដំណើរការទេ។ សូមភ្ជាប់ Demucs API ក្នុងផ្ទាំង «ញែកភ្លេង · Demucs API»។';

/** Video and audio are both uploaded to the same endpoint. */
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i;
const isAudioFile = (file: File) =>
  file.type.startsWith('audio/') || (!file.type.startsWith('video/') && AUDIO_RE.test(file.name));

/**
 * Two products on one site, deliberately separate: pull a voice out of a mix, or
 * clean the noise off a voice you already recorded. The tabs sit above both
 * studios so a visitor knows which one they are in.
 */
type StudioMode = 'separate' | 'clean';

const ModeTabs: React.FC<{ mode: StudioMode; onChange: (mode: StudioMode) => void }> = ({
  mode,
  onChange,
}) => (
  <div
    role="tablist"
    aria-label="ជ្រើសរើសការងារ"
    className="grid grid-cols-2 gap-1.5 p-1.5 rounded-2xl bg-slate-900/70 border border-slate-800"
  >
    <button
      type="button"
      role="tab"
      aria-selected={mode === 'separate'}
      onClick={() => onChange('separate')}
      className={`min-h-[46px] px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors ${
        mode === 'separate'
          ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
          : 'text-slate-400 hover:text-slate-200 border border-transparent'
      }`}
    >
      <AudioLines className="w-4 h-4" />
      ញែកសំឡេងពីភ្លេង
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={mode === 'clean'}
      onClick={() => onChange('clean')}
      className={`min-h-[46px] px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors ${
        mode === 'clean'
          ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40'
          : 'text-slate-400 hover:text-slate-200 border border-transparent'
      }`}
    >
      <Sparkles className="w-4 h-4" />
      សម្អាតសំឡេង (Gemini)
    </button>
  </div>
);

export function App() {
  const [mode, setMode] = useState<StudioMode>('separate');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoResolution, setVideoResolution] = useState<{ width: number; height: number } | null>(
    null
  );

  /**
   * Demucs is the product, so the studio has to say so before a file is chosen
   * rather than after the upload is refused. `null` means "a stem service is
   * connected" or "the probe failed" — in the second case the studio stays
   * open, because the upload endpoint makes the same check again on the server.
   */
  const [demucsNotice, setDemucsNotice] = useState<string | null>(null);
  /** Bumped when the stem-separation panel changes the connection. */
  const [demucsCheckToken, setDemucsCheckToken] = useState(0);

  /**
   * The live answer to "is the Colab studio answering right now?" — the same
   * probe the header badge shows. A saved URL outlives the session behind it, so
   * the upload waits for this instead of spending a file on a dead tunnel and
   * reporting it six minutes later.
   */
  const live = useLiveStatus();
  const liveNotice = live.data && !live.data.stems ? live.data.message : null;
  const blocker = demucsNotice || liveNotice;

  const [currentJob, setCurrentJob] = useState<JobRecord | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const sseUnsubscribeRef = useRef<(() => void) | null>(null);

  /**
   * Name the tab after what it shows. Search results and shared links take
   * their heading from here.
   */
  useEffect(() => {
    document.title =
      mode === 'clean'
        ? 'សម្អាតសំឡេង · Clean the noise off a recording'
        : 'ញែកសំឡេងចេញពីភ្លេង · Separate voice from music';
  }, [mode]);

  // Subscribe to SSE updates when a job is active
  useEffect(() => {
    if (!currentJob) return;

    if (currentJob.status !== 'completed' && currentJob.status !== 'failed') {
      if (sseUnsubscribeRef.current) {
        sseUnsubscribeRef.current();
      }

      // Start SSE listener
      const unsub = subscribeToJobUpdates(
        currentJob.id,
        (updatedJob) => {
          setCurrentJob(updatedJob);
        },
        () => {
          // Fallback poll every 2.5s if SSE disconnects
          const interval = setInterval(async () => {
            try {
              const fresh = await getJob(currentJob.id);
              setCurrentJob(fresh);
              if (fresh.status === 'completed' || fresh.status === 'failed') {
                clearInterval(interval);
              }
            } catch {}
          }, 2500);
          return () => clearInterval(interval);
        }
      );

      sseUnsubscribeRef.current = unsub;
    }

    return () => {
      if (sseUnsubscribeRef.current) {
        sseUnsubscribeRef.current();
        sseUnsubscribeRef.current = null;
      }
    };
  }, [currentJob?.id, currentJob?.status]);

  // Clean object URL on unmount or file change
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFileSelect = (file: File) => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedFile(file);
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    setVideoResolution(null);

    // Read metadata: an <audio> element for a bare sound file, a <video> one
    // otherwise. The duration is what tells the visitor they picked the right
    // file before they spend a minute waiting on the separator.
    if (isAudioFile(file)) {
      const tempAudio = document.createElement('audio');
      tempAudio.preload = 'metadata';
      tempAudio.src = objectUrl;
      tempAudio.onloadedmetadata = () => {
        // The same object URL stays in state for the preview player, so it is
        // revoked on the next selection — never here.
        setVideoDuration(Number.isFinite(tempAudio.duration) ? tempAudio.duration : null);
      };
      return;
    }

    const tempVideo = document.createElement('video');
    tempVideo.preload = 'metadata';
    tempVideo.src = objectUrl;

    tempVideo.onloadedmetadata = () => {
      setVideoDuration(tempVideo.duration);
      setVideoResolution({
        width: tempVideo.videoWidth,
        height: tempVideo.videoHeight,
      });
    };
  };

  /**
   * Re-read the stem-service state whenever the studio is opened: the owner may
   * have just reconnected a phone tunnel, and the panel that stores it is on this
   * very screen.
   */
  useEffect(() => {
    let cancelled = false;

    getSystemConfigStatus()
      .then((status) => {
        if (cancelled) return;
        setDemucsNotice(
          status.audioSeparation.configured
            ? null
            : status.audioSeparation.message || DEMUCS_REQUIRED_NOTICE
        );
      })
      .catch(() => {
        if (cancelled) return;
        setDemucsNotice(null);
      });

    return () => {
      cancelled = true;
    };
  }, [demucsCheckToken]);

  // A URL saved (or cleared) in either card changes the answer, so ask again.
  useEffect(() => {
    if (demucsCheckToken > 0) live.refresh();
    // `refresh` is re-created per render; the token is what should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demucsCheckToken]);

  const handleStartSeparating = async () => {
    if (!selectedFile) return;

    if (blocker) {
      alert(blocker);
      return;
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      const result = await uploadSeparationJob(selectedFile, (pct) => {
        setUploadProgress(pct);
      });

      setCurrentJob(result.job);
    } catch (err: any) {
      alert(err?.message || 'ការបញ្ចូលឯកសារបរាជ័យ');
    } finally {
      setIsUploading(false);
    }
  };

  const handleReset = () => {
    if (sseUnsubscribeRef.current) {
      sseUnsubscribeRef.current();
      sseUnsubscribeRef.current = null;
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(null);
    setPreviewUrl(null);
    setVideoDuration(null);
    setVideoResolution(null);
    setCurrentJob(null);
  };

  return (
    <div className="min-h-screen bg-[#070b12] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* App Header */}
      <Header />

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-7 space-y-6 sm:space-y-8">
        <ModeTabs mode={mode} onChange={setMode} />

        {/* The Gemini cleanup keeps its own screen, state and result view. */}
        {mode === 'clean' && <CleanStudio />}

        {mode === 'separate' && (
        <>
          {/* If no job in progress or finished, show Upload & Settings */}
          {!currentJob && (
            <div className="space-y-8 animate-in fade-in duration-300">
              {/* Demucs is required: without it the server refuses the upload, so
                  the reason is shown before anyone picks a file. */}
              {blocker && (
                <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/40 text-amber-200 text-xs leading-relaxed flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-sm text-amber-300">
                      {liveNotice
                        ? 'API មិនទាន់ភ្ជាប់ — សូមរត់ cell ក្នុង Colab ម្តងទៀត'
                        : 'Demucs ចាំបាច់ — បើគ្មានវា គេហទំព័រមិនដំណើរការទេ'}
                    </div>
                    <p className="mt-1 text-slate-300">{blocker}</p>
                  </div>
                </div>
              )}

              {/* Which Demucs/stem service does the separation. */}
              <DemucsPanel onConnectionChange={() => setDemucsCheckToken((token) => token + 1)} />

              {/* Where the free voice converter (Colab/Kaggle) is pasted. It sits
                  next to Demucs because both are set up once, before any job — a
                  cloned dub is only offered further down the page. */}
              <VoiceCloneApiPanel />

              {/* Upload Panel */}
              <UploadPanel
                onFileSelect={handleFileSelect}
                selectedFile={selectedFile}
                previewUrl={previewUrl}
                videoDuration={videoDuration}
                videoResolution={videoResolution}
                onStart={handleStartSeparating}
                isUploading={isUploading}
                uploadProgress={uploadProgress}
                startBlocked={Boolean(blocker)}
              />
            </div>
          )}

          {/* If job is processing or failed */}
          {currentJob && currentJob.status !== 'completed' && (
            <div className="max-w-4xl mx-auto animate-in fade-in duration-300">
              <ProcessingProgress job={currentJob} onRetry={handleReset} />
            </div>
          )}

          {/* If the separation finished, show the two downloads */}
          {currentJob && currentJob.status === 'completed' && (
            <div className="animate-in fade-in duration-300">
              <ResultPanel job={currentJob} onReset={handleReset} />
            </div>
          )}
        </>
        )}
      </main>

      {/* Modern Minimal Footer */}
      <footer className="border-t border-slate-900 py-6 px-4 pb-8 text-center text-[11px] sm:text-xs text-slate-400 leading-relaxed">
        <p className="mx-auto max-w-md">
          ញែកសំឡេងនិយាយ និងសំឡេងច្រៀងចេញពីភ្លេង · សម្អាតសំឡេងឲ្យស្អាត — ឥតគិតថ្លៃ
        </p>
        <p className="mt-1 text-[10px] text-slate-500 sm:text-[11px]">
          Separate voice &amp; singing from music · Clean the noise off a recording · Free
        </p>
      </footer>
    </div>
  );
}

export default App;
