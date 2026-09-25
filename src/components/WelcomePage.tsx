import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Crown,
  Download,
  Languages,
  Music4,
  RefreshCw,
  Sparkles,
  Upload,
  Zap,
} from 'lucide-react';
import { getUsageStats } from '../lib/usage';
import { getAuthConfig, signInWithGoogle, SignedInUser } from '../lib/api';
import { GoogleSignInButton } from './GoogleSignInButton';
import { GoogleMark } from './GoogleMark';
import {
  CANONICAL_HOST,
  CANONICAL_ORIGIN,
  DEFAULT_GOOGLE_CLIENT_ID,
  isRegisteredOrigin,
} from '../lib/google';

interface WelcomePageProps {
  /**
   * Leaves the welcome screen for the dubbing studio. The app navigation (tab
   * bar) only shows once the visitor is inside the app.
   */
  onEnterApp?: () => void;
  /** The Google account signed in on this device, if any. */
  user?: SignedInUser | null;
  /**
   * Called after a successful Google sign-in with the stored account and the
   * session token that claims its videos, history and usage.
   */
  onSignedIn?: (user: SignedInUser, token: string) => void;
}

type Status = { kind: 'saved' | 'error' | 'info'; text: string };

/** What the pipeline actually does, so the promise on the hero is concrete. */
const STEPS = [
  {
    icon: Upload,
    title: 'បញ្ចូលវីដេអូ',
    detail: 'MP4 · MOV · MKV រហូតដល់ 2 នាទី (Free)',
  },
  {
    icon: Languages,
    title: 'AI បកប្រែ និងបង្កើតសំឡេង',
    detail: 'Whisper large-v3 ស្តាប់ → បកប្រែខ្មែរ → Edge TTS',
  },
  {
    icon: Download,
    title: 'ទាញយកលទ្ធផល',
    detail: 'MP4 សំឡេងខ្មែរ · អក្សររត់ SRT/VTT · WAV',
  },
];

/** The promises the product keeps on every finished video. */
const FEATURES = [
  { icon: Music4, label: 'រក្សាភ្លេងដើម' },
  { icon: Languages, label: 'សំឡេងខ្មែរធម្មជាតិ' },
];

export const WelcomePage: React.FC<WelcomePageProps> = ({ onEnterApp, user, onSignedIn }) => {
  // Step 1: only "Get started". Step 2 (after the click): sign in with Google.
  const [showSignIn, setShowSignIn] = useState(false);
  const [authConfig, setAuthConfig] = useState<{ configured: boolean; clientId: string | null } | null>(
    null
  );
  /** The server could not be reached — the sign-in button still works. */
  const [configFailed, setConfigFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Bumped by the retry button to re-run the config probe. */
  const [retryToken, setRetryToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const stats = getUsageStats();
  // Cloudflare gives every deploy its own host; Google only knows the real domain.
  const origin = typeof window === 'undefined' ? CANONICAL_ORIGIN : window.location.origin;
  const originRegistered = isRegisteredOrigin(origin);

  // Only ask the server about Google sign-in once the visitor is past the CTA.
  useEffect(() => {
    if (!showSignIn) return;

    let cancelled = false;
    setChecking(true);

    getAuthConfig()
      .then((config) => {
        if (cancelled) return;
        setAuthConfig(config);
        setConfigFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setConfigFailed(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showSignIn, retryToken]);

  /**
   * The id Google needs. Until the server answers we paint the button with the
   * public built-in id, so a sleeping server never leaves the visitor staring at
   * a spinner; the server's answer always wins once it arrives.
   */
  const clientId = authConfig
    ? authConfig.configured
      ? authConfig.clientId
      : null
    : DEFAULT_GOOGLE_CLIENT_ID;

  /** Google handed us a fresh access token — trade it for a stored account. */
  const handleToken = async (accessToken: string) => {
    setBusy(true);
    setStatus(null);

    try {
      const { user: account, token } = await signInWithGoogle(accessToken);
      onSignedIn?.(account, token);
      setStatus({ kind: 'saved', text: `បានរក្សាទុកគណនីរបស់អ្នករួចរាល់ ✓ (${account.email})` });
      // Straight into the studio — the tab bar only appears inside the app.
      window.setTimeout(() => onEnterApp?.(), 900);
    } catch (err) {
      setStatus({
        kind: 'error',
        text:
          err instanceof Error && err.message
            ? err.message
            : 'ការចូលដោយ Google បរាជ័យ។ សូមព្យាយាមម្តងទៀត។',
      });
    } finally {
      setBusy(false);
    }
  };

  /** Returning (already signed-in) visitors skip the sign-in card entirely. */
  const handleGetStarted = () => {
    if (user) {
      onEnterApp?.();
      return;
    }
    setShowSignIn(true);
  };

  const backToStart = () => {
    setShowSignIn(false);
    setStatus(null);
  };

  /** The one-line summary under the heading: who is signed in, or the free allowance. */
  const renderMeta = () => {
    if (user) {
      return (
        <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          បានចូលជា {user.email}
        </span>
      );
    }
    if (stats.unlimited) {
      return (
        <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
          <Crown className="h-4 w-4 shrink-0" />
          Pro plan សកម្ម — វីដេអូឥតកំណត់
        </span>
      );
    }
    return <span>ឥតគិតថ្លៃ {stats.limit} វីដេអូ/ថ្ងៃ · មិនត្រូវការកាតឥណទាន</span>;
  };

  return (
    <div className="animate-in fade-in duration-300">
      <section className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-emerald-950/40 via-[#0b1220] to-[#0b0f17] px-5 py-10 sm:px-10 sm:py-16">
        {/* Ambient light, kept behind the content. */}
        <div className="pointer-events-none absolute -top-24 -right-20 h-64 w-64 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -left-20 h-64 w-64 rounded-full bg-teal-500/10 blur-3xl" />

        <div className="relative mx-auto max-w-2xl text-center">
          <div className="inline-flex flex-wrap items-center justify-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-1.5 text-[11px] font-semibold text-emerald-300 sm:text-xs">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>បកប្រែវីដេអូ និងបញ្ចូលសំឡេងខ្មែរ ដោយ AI</span>
          </div>

          {/* Who we are — the website introduces itself before asking for anything. */}
          <h1 className="mt-6 text-3xl font-bold leading-snug tracking-tight text-white sm:text-4xl">
            AI translate video
            <span className="mt-1 block text-emerald-400">បកប្រែវីដេអូជាភាសាខ្មែរ</span>
          </h1>

          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-slate-300 sm:text-base">
            សូមស្វាគមន៍មកកាន់ websites «AI translate video» — បញ្ចូលវីដេអូភាសាបរទេសមួយ
            រួចទទួលបានវីដេអូសំឡេងខ្មែរធម្មជាតិ អក្សររត់ខ្មែរ និងឯកសារទាញយក
            ដោយរក្សាភ្លេង និងសំឡេងបរិយាកាសដើម។
          </p>

          {/* Step 1 — the only call to action on arrival */}
          {!showSignIn && (
            <div className="mt-8">
              <button
                type="button"
                onClick={handleGetStarted}
                className="inline-flex min-h-[56px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-8 py-4 text-base font-bold text-white shadow-lg shadow-emerald-500/25 transition-all hover:from-emerald-400 hover:to-teal-400 active:scale-95 sm:w-auto sm:text-lg"
              >
                <Zap className="h-5 w-5 shrink-0" />
                <span>{user ? 'បន្តទៅស្ទូឌីយោ' : 'Get started'}</span>
                <ArrowRight className="h-5 w-5 shrink-0" />
              </button>

              <p className="mt-4 text-[11px] text-slate-400 sm:text-xs">{renderMeta()}</p>
            </div>
          )}

          {/* Step 2 — revealed after "Get started" */}
          {showSignIn && (
            <div className="mt-8 animate-in fade-in slide-in-from-bottom-2 duration-300 text-left">
              <div className="rounded-2xl border border-slate-800 bg-[#111827]/80 p-5 shadow-xl shadow-black/20 sm:p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-md shadow-black/30">
                    <GoogleMark className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-base font-bold leading-tight text-white sm:text-lg">
                      ចូលដោយ Google
                    </h2>
                    <p className="text-[11px] text-slate-400 sm:text-xs">
                      គ្មានលេខសម្ងាត់ · ចុចតែម្តង
                    </p>
                  </div>
                </div>

                {user ? (
                  /* Signed in — the account row doubles as the way back in. */
                  <button
                    type="button"
                    onClick={() => onEnterApp?.()}
                    className="mt-4 flex w-full items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5 text-left transition-colors hover:bg-emerald-500/10 active:scale-[0.99]"
                  >
                    {user.picture ? (
                      <img
                        src={user.picture}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-10 w-10 shrink-0 rounded-full border border-emerald-500/30"
                      />
                    ) : (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-emerald-500/25 bg-emerald-500/15 font-bold text-emerald-300">
                        {user.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-white">
                        {user.name}
                      </span>
                      <span className="block truncate text-[11px] text-slate-400 sm:text-xs">
                        {user.email}
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-emerald-300" />
                  </button>
                ) : (
                  <>
                    <p className="mt-4 text-sm leading-relaxed text-slate-300">
                      សូម Login ដោយ Account Google របស់លោកអ្នក ដើម្បីបន្តទៅ websites បាន
                    </p>

                    <div className="mt-4 space-y-3">
                      {clientId ? (
                        <GoogleSignInButton
                          clientId={clientId}
                          onToken={handleToken}
                          onUnavailable={(text) => setStatus({ kind: 'error', text })}
                          disabled={busy}
                        />
                      ) : (
                        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3.5">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                          <p className="text-[11px] leading-relaxed text-amber-200 sm:text-xs">
                            Google sign-in មិនទាន់បានភ្ជាប់ទេ។ ត្រូវការ{' '}
                            <span className="font-semibold">GOOGLE_CLIENT_ID</span> នៅលើម៉ាស៊ីនបម្រើ
                            (Render → Environment)។
                          </p>
                        </div>
                      )}

                      {/* A free server that was asleep can take a moment — say so instead
                          of leaving the card in a silent, endless "checking" state. */}
                      {checking && (
                        <p className="flex items-center gap-2 text-[11px] text-slate-400 sm:text-xs">
                          <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
                          កំពុងភ្ជាប់ទៅម៉ាស៊ីនបម្រើ… លើកដំបូងអាចចំណាយពេលបន្តិច។
                        </p>
                      )}

                      {configFailed && !checking && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-700/60 bg-slate-800/40 p-3">
                          <p className="flex-1 text-[11px] leading-relaxed text-slate-300 sm:text-xs">
                            មិនអាចទាក់ទងម៉ាស៊ីនបម្រើបានទេ។ ប៊ូតុង Google នៅដំណើរការធម្មតា —
                            បើមិនចេញ សូមព្យាយាមម្តងទៀត។
                          </p>
                          <button
                            type="button"
                            onClick={() => setRetryToken((n) => n + 1)}
                            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-slate-600 px-2.5 text-[11px] font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700/50 sm:text-xs"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            ព្យាយាមម្តងទៀត
                          </button>
                        </div>
                      )}

                      {busy && (
                        <p className="flex items-center justify-center gap-2 text-xs text-emerald-300">
                          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-400/40 border-t-emerald-400" />
                          កំពុងរក្សាទុកគណនី…
                        </p>
                      )}

                      {!originRegistered && (
                        <p className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-200 sm:text-xs">
                          ដែននេះនៅទីតាំង{' '}
                          <span className="font-semibold">{origin}</span> មិនទាន់បានចុះឈ្មោះជាមួយ
                          Google ទេ — ការចូលនឹងបង្ហាញ «origin_mismatch»។ សូមប្រើ{' '}
                          <a
                            href={CANONICAL_ORIGIN}
                            className="font-semibold underline hover:text-amber-100"
                          >
                            {CANONICAL_HOST}
                          </a>
                        </p>
                      )}
                    </div>
                  </>
                )}

                {status && (
                  <p
                    className={`mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed sm:text-xs ${
                      status.kind === 'saved'
                        ? 'text-emerald-300'
                        : status.kind === 'error'
                          ? 'text-rose-300'
                          : 'text-slate-400'
                    }`}
                    role="status"
                  >
                    {status.kind === 'saved' && (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>{status.text}</span>
                  </p>
                )}

                {!user && (
                  <button
                    type="button"
                    onClick={backToStart}
                    className="mt-4 inline-flex min-h-[32px] items-center gap-1.5 text-[11px] text-slate-500 transition-colors hover:text-slate-300 sm:text-xs"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    ត្រឡប់ក្រោយ
                  </button>
                )}
              </div>
            </div>
          )}

          {/* How the website works — only worth reading on arrival. */}
          {!showSignIn && (
            <>
              <div className="mt-10 grid gap-3 text-left sm:grid-cols-3">
                {STEPS.map(({ icon: Icon, title, detail }) => (
                  <div
                    key={title}
                    className="rounded-2xl border border-white/5 bg-white/[0.03] p-4 transition-colors hover:border-emerald-500/20 hover:bg-emerald-500/[0.04]"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                      <Icon className="h-4 w-4" />
                    </span>
                    <p className="mt-3 text-sm font-semibold text-white">{title}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-400 sm:text-xs">
                      {detail}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-slate-400 sm:text-xs">
                {FEATURES.map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 text-emerald-400" />
                    {label}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
};
