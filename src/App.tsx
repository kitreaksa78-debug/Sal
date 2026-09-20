import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UploadPanel } from './components/UploadPanel';
import { TranslationSettings } from './components/TranslationSettings';
import { ProcessingProgress } from './components/ProcessingProgress';
import { ResultPanel } from './components/ResultPanel';
import { JobHistory } from './components/JobHistory';
import { ConfigModal } from './components/ConfigModal';
import { PricingPage } from './components/PricingPage';
import { UsageBanner } from './components/UsageBanner';
import { JobRecord, JobSettings, SystemConfigStatus } from './types';
import {
  uploadVideoJob,
  getJob,
  getSystemConfigStatus,
  subscribeToJobUpdates,
  getEntitlement,
  activatePurchase,
} from './lib/api';
import {
  canUseFreePlan,
  canProcessVideo,
  recordUsage,
  getUsageStats,
  getAccountEmail,
  setPlan,
} from './lib/usage';

export function App() {
  const [activeTab, setActiveTab] = useState<'studio' | 'history' | 'status' | 'pricing'>('studio');
  const [usageStats, setUsageStats] = useState(getUsageStats());
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoResolution, setVideoResolution] = useState<{ width: number; height: number } | null>(null);

  const [settings, setSettings] = useState<JobSettings>({
    voice: 'auto',
    voiceStyle: 'natural',
    backgroundMusic: 'keep',
    subtitle: true,
    outputQuality: 'original',
    translationStyle: 'natural',
    smartVoice: true,
  });

  const [currentJob, setCurrentJob] = useState<JobRecord | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [configStatus, setConfigStatus] = useState<SystemConfigStatus | null>(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);

  const sseUnsubscribeRef = useRef<(() => void) | null>(null);

  // Fetch system config on load
  const loadConfig = async () => {
    try {
      setConfigLoading(true);
      const data = await getSystemConfigStatus();
      setConfigStatus(data);
    } catch (err) {
      console.warn('Failed to load system config status:', err);
    } finally {
      setConfigLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  /**
   * Re-check the Pro plan for the email remembered on this device. Right after a
   * checkout the webhook may not have landed yet, so that path asks the billing
   * API to confirm the purchase directly instead of trusting local state.
   */
  const refreshPlan = async (fromCheckout: boolean) => {
    const email = getAccountEmail();
    if (!email) return;
    try {
      if (fromCheckout) {
        const result = await activatePurchase(email);
        setPlan(result.plan, result.email);
      } else {
        const result = await getEntitlement(email);
        setPlan(result.plan);
      }
    } catch {
      // Keep the plan already stored on this device; the billing page can retry.
    } finally {
      setUsageStats(getUsageStats());
    }
  };

  // LemonSqueezy sends the buyer back with ?upgraded=1 after a successful payment.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromCheckout = params.get('upgraded') === '1';
    void refreshPlan(fromCheckout);
    if (fromCheckout) {
      params.delete('upgraded');
      const query = params.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}`
      );
    }
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    };
  }, [videoPreviewUrl]);

  const handleFileSelect = (file: File) => {
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }

    setSelectedFile(file);
    const objectUrl = URL.createObjectURL(file);
    setVideoPreviewUrl(objectUrl);

    // Read metadata via HTML video element
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

  const handleStartDubbing = async () => {
    if (!selectedFile) return;

    // Check free plan limits
    const freeCheck = canUseFreePlan();
    if (!freeCheck.allowed) {
      alert(freeCheck.reason);
      setActiveTab('pricing');
      return;
    }

    // Check video duration
    if (videoDuration) {
      const durationCheck = canProcessVideo(videoDuration);
      if (!durationCheck.allowed) {
        alert(durationCheck.reason);
        setActiveTab('pricing');
        return;
      }
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      const result = await uploadVideoJob(selectedFile, settings, (pct) => {
        setUploadProgress(pct);
      });

      // Record usage
      if (videoDuration) {
        recordUsage(videoDuration);
        setUsageStats(getUsageStats());
      }

      setCurrentJob(result.job);
      setActiveTab('studio');
    } catch (err: any) {
      alert(err?.message || 'ការបញ្ចូលវីដេអូបរាជ័យ');
    } finally {
      setIsUploading(false);
    }
  };

  const handleReset = () => {
    if (sseUnsubscribeRef.current) {
      sseUnsubscribeRef.current();
      sseUnsubscribeRef.current = null;
    }
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }
    setSelectedFile(null);
    setVideoPreviewUrl(null);
    setVideoDuration(null);
    setVideoResolution(null);
    setCurrentJob(null);
  };

  const handleSelectJobFromHistory = (job: JobRecord) => {
    setCurrentJob(job);
    setActiveTab('studio');
  };

  return (
    <div className="min-h-screen bg-[#070b12] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* App Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        configStatus={configStatus}
        onOpenConfig={() => {
          loadConfig();
          setIsConfigModalOpen(true);
        }}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
        {activeTab === 'studio' && (
          <>
            {/* If no job in progress or finished, show Upload & Settings */}
            {!currentJob && (
              <div className="space-y-8 animate-in fade-in duration-300">
                {/* Upload Panel */}
                <UploadPanel
                  onFileSelect={handleFileSelect}
                  selectedFile={selectedFile}
                  videoPreviewUrl={videoPreviewUrl}
                  videoDuration={videoDuration}
                  videoResolution={videoResolution}
                  settings={settings}
                  onStartDubbing={handleStartDubbing}
                  isUploading={isUploading}
                  uploadProgress={uploadProgress}
                />

                {/* Settings Panel */}
                <TranslationSettings
                  settings={settings}
                  onChange={setSettings}
                  disabled={isUploading}
                />
              </div>
            )}

            {/* If job is processing or failed */}
            {currentJob && currentJob.status !== 'completed' && (
              <div className="max-w-4xl mx-auto animate-in fade-in duration-300">
                <ProcessingProgress
                  job={currentJob}
                  onRetry={handleReset}
                />
              </div>
            )}

            {/* If job is completed, show Result Panel */}
            {currentJob && currentJob.status === 'completed' && (
              <div className="animate-in fade-in duration-300">
                <ResultPanel
                  job={currentJob}
                  onReset={handleReset}
                />
              </div>
            )}
          </>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="max-w-4xl mx-auto animate-in fade-in duration-300">
            <JobHistory onSelectJob={handleSelectJobFromHistory} />
          </div>
        )}

        {/* Pricing Tab */}
        {activeTab === 'pricing' && (
          <div className="animate-in fade-in duration-300">
            <PricingPage
              onSelectPlan={(plan) => {
                if (plan === 'free') setActiveTab('studio');
                // The Pro button opens the LemonSqueezy checkout itself.
              }}
              onPlanChange={() => setUsageStats(getUsageStats())}
            />
          </div>
        )}
      </main>

      {/* System Status / Admin Configuration Modal */}
      <ConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
        config={configStatus}
        loading={configLoading}
      />

      {/* Modern Minimal Footer */}
      <footer className="border-t border-slate-900 py-6 px-4 text-center text-xs text-slate-400">
        <p>KhmerDub AI • Professional AI Video Translation & Cambodian Khmer Dubbing Platform</p>
      </footer>
    </div>
  );
}

export default App;
