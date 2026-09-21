import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UploadPanel } from './components/UploadPanel';
import { TranslationSettings } from './components/TranslationSettings';
import { ProcessingProgress } from './components/ProcessingProgress';
import { ResultPanel } from './components/ResultPanel';
import { JobHistory } from './components/JobHistory';
import { PricingPage } from './components/PricingPage';
import { WelcomePage } from './components/WelcomePage';
import { JobRecord, JobSettings } from './types';
import {
  uploadVideoJob,
  getJob,
  subscribeToJobUpdates,
  getEntitlement,
  activatePurchase,
  getMe,
  getUsage,
  signOut,
  ApiError,
  SignedInUser,
} from './lib/api';
import { getSignedInUser, saveSession, clearSession, getAuthToken } from './lib/auth';
import {
  canUseFreePlan,
  canProcessVideo,
  getUsageStats,
  applyServerUsage,
  getAccountEmail,
  getPlan,
  setPlan,
} from './lib/usage';

export function App() {
  const [activeTab, setActiveTab] = useState<'welcome' | 'studio' | 'history' | 'pricing'>('welcome');

  const [usageStats, setUsageStats] = useState(getUsageStats());
  const [user, setUser] = useState<SignedInUser | null>(getSignedInUser());
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

  const sseUnsubscribeRef = useRef<(() => void) | null>(null);

  /**
   * Re-check the Pro plan for the signed-in account. Right after a checkout the
   * webhook may not have landed yet, so that path asks the billing API to confirm
   * the purchase directly instead of trusting local state.
   */
  const refreshPlan = async (fromCheckout: boolean, email?: string | null) => {
    const address = email ?? user?.email ?? getAccountEmail();
    if (!address) return;
    try {
      if (fromCheckout) {
        const result = await activatePurchase(address);
        setPlan(result.plan, result.email);
      } else {
        const result = await getEntitlement(address);
        setPlan(result.plan, address);
      }
    } catch {
      // Keep the plan already stored for this account; the billing page can retry.
    } finally {
      setUsageStats(getUsageStats());
    }
  };

  /**
   * Pull the account's own counter back from the server, which is the one that
   * actually counts uploads — that is why the free tier cannot be reset by
   * clearing the browser or moving to another device.
   */
  const syncUsage = async () => {
    try {
      applyServerUsage(await getUsage());
    } catch {
      // Offline or sleeping server: keep the mirror this device already has.
    } finally {
      setUsageStats(getUsageStats());
    }
  };

  // Confirm the saved sign-in and load this account's own plan and usage.
  useEffect(() => {
    const account = getSignedInUser();
    if (!account) {
      setUsageStats(getUsageStats());
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const fresh = await getMe();
        if (cancelled) return;
        saveSession(fresh, getAuthToken());
        setUser(fresh);
      } catch (err) {
        if (cancelled) return;
        // Only a 401 means the session is really gone; a sleeping server must
        // not sign the visitor out.
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          setUser(null);
        }
        setUsageStats(getUsageStats());
        return;
      }

      await refreshPlan(false, account.email);
      await syncUsage();
    })();

    return () => {
      cancelled = true;
    };
    // Re-runs when a different account signs in on this device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // The studio, history and pricing all belong to a signed-in account.
  useEffect(() => {
    if (!user && activeTab !== 'welcome') setActiveTab('welcome');
  }, [user, activeTab]);

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

      // The server counted this upload against the account when the job was
      // created; mirror its number here.
      void syncUsage();

      setCurrentJob(result.job);
      setActiveTab('studio');
    } catch (err: any) {
      alert(err?.message || 'ការបញ្ចូលវីដេអូបរាជ័យ');
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Google sign-in succeeded — the server stored the account and handed back the
   * session token that every later request uses to claim this account's data.
   */
  const handleSignedIn = (account: SignedInUser, token: string) => {
    saveSession(account, token);
    setUser(account);
    // Scoped to the account, so switching accounts shows the other one's plan.
    setPlan(getPlan(), account.email);
    setUsageStats(getUsageStats());
    void refreshPlan(false, account.email);
    void syncUsage();
  };

  const handleSignOut = async () => {
    await signOut();
    clearSession();
    setUser(null);
    // Never leave one account's video or result on screen for the next person.
    handleReset();
    setActiveTab('welcome');
    setUsageStats(getUsageStats());
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
        /* The tab bar belongs to the app, not to the welcome screen. */
        showNav={activeTab !== 'welcome'}
        user={user}
        onSignOut={handleSignOut}
      />

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-7 space-y-6 sm:space-y-8">
        {/* Welcome / landing screen */}
        {activeTab === 'welcome' && (
          <WelcomePage
            onEnterApp={() => setActiveTab('studio')}
            user={user}
            onSignedIn={handleSignedIn}
          />
        )}

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
                  usageStats={usageStats}
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

      {/* Modern Minimal Footer */}
      <footer className="border-t border-slate-900 py-6 px-4 pb-8 text-center text-[11px] sm:text-xs text-slate-400 leading-relaxed">
        <p>KhmerDub AI • Professional AI Video Translation &amp; Cambodian Khmer Dubbing Platform</p>
      </footer>
    </div>
  );
}

export default App;
