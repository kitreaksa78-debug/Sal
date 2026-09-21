import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Crown,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import { getUsageStats } from '../lib/usage';
import { getAuthConfig, signInWithGoogle, SignedInUser } from '../lib/api';
import { GoogleSignInButton } from './GoogleSignInButton';
import { GoogleMark } from './GoogleMark';
import { CANONICAL_ORIGIN, isRegisteredOrigin } from '../lib/google';

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

export const WelcomePage: React.FC<WelcomePageProps> = ({ onEnterApp, user, onSignedIn }) => {
  // Step 1: only "Get started". Step 2 (after the click): sign in with Google.
  const [showSignIn, setShowSignIn] = useState(false);
  const [authConfig, setAuthConfig] = useState<{ configured: boolean; clientId: string | null } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const stats = getUsageStats();
  // Cloudflare gives every deploy its own host; Google only knows the real domain.
  const origin = typeof window === 'undefined' ? CANONICAL_ORIGIN : window.location.origin;
  const originRegistered = isRegisteredOrigin(origin);

  // Only ask the server about Google sign-in once the visitor is past the CTA.
  useEffect(() => {
    if (!showSignIn || authConfig) return;

    let cancelled = false;
    getAuthConfig()
      .then((config) => {
        if (!cancelled) setAuthConfig(config);
      })
      .catch(() => {
        if (!cancelled) setAuthConfig({ configured: false, clientId: null });
      });

    return () => {
      cancelled = true;
    };
  }, [showSignIn, authConfig]);

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

  return (
    <div className="animate-in fade-in duration-300">
      <section className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-emerald-950/40 via-[#0b1220] to-[#0b0f17] px-5 py-9 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -top-24 -right-20 h-60 w-60 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -left-20 h-60 w-60 rounded-full bg-teal-500/10 blur-3xl" />

        <div className="relative mx-auto max-w-xl text-center">
          <div className="inline-flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[11px] sm:text-xs font-semibold text-emerald-300">
            <Sparkles className="w-3.5 h-3.5" />
            <span>វេទិកាបកប្រែវីដេអូ និងបញ្ចូលសំឡេងខ្មែរ AI</span>
          </div>

          <h2 className="mt-5 text-2xl sm:text-4xl font-bold text-white tracking-tight leading-snug">
            សូមស្វាគមន៍មកកាន់ <span className="text-emerald-400">KhmerDub AI</span>
          </h2>

          <p className="mt-3 text-sm sm:text-base text-slate-300 leading-relaxed">
            បំលែងវីដេអូភាសាបរទេស ទៅជាវីដេអូភាសាខ្មែរ ដោយរក្សាភ្លេង និងសំឡេងបរិយាកាសដើម។
          </p>

          {/* Step 1 — the only call to action on arrival */}
          {!showSignIn && (
            <div className="mt-7">
              <button
                type="button"
                onClick={handleGetStarted}
                className="inline-flex items-center justify-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white font-bold text-base sm:text-lg shadow-lg shadow-emerald-500/25 active:scale-95 transition-all min-h-[56px] w-full sm:w-auto"
              >
                <Zap className="w-5 h-5 shrink-0" />
                <span>{user ? 'បន្តទៅស្ទូឌីយោ' : 'Get started'}</span>
                <ArrowRight className="w-5 h-5 shrink-0" />
              </button>

              <p className="mt-4 text-[11px] sm:text-xs text-slate-400">
                {user ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-300 font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5" /> បានចូលជា {user.email}
                  </span>
                ) : stats.unlimited ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-300 font-semibold">
                    <Crown className="w-3.5 h-3.5" /> Pro plan សកម្ម — វីដេអូឥតកំណត់
                  </span>
                ) : (
                  <>ឥតគិតថ្លៃ {stats.limit} វីដេអូ/ថ្ងៃ · មិនត្រូវការកាត</>
                )}
              </p>
            </div>
          )}

          {/* Step 2 — revealed after "Get started" */}
          {showSignIn && (
            <div className="mt-7 text-left animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="rounded-2xl border border-slate-800 bg-[#111827]/80 p-5 sm:p-6 shadow-xl shadow-black/20">
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl bg-white flex items-center justify-center shrink-0 shadow-md shadow-black/30">
                    <GoogleMark className="w-5 h-5" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-base sm:text-lg font-bold text-white leading-tight">
                      ចូលដោយ Google
                    </h3>
                    <p className="text-[11px] sm:text-xs text-slate-400">
                      គ្មានលេខសម្ងាត់ · ចុចតែម្តង
                    </p>
                  </div>
                </div>

                {user ? (
                  /* Signed in — the account row doubles as the way back in. */
                  <button
                    type="button"
                    onClick={() => onEnterApp?.()}
                    className="mt-4 w-full flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5 text-left transition-colors hover:bg-emerald-500/10 active:scale-[0.99]"
                  >
                    {user.picture ? (
                      <img
                        src={user.picture}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-10 h-10 rounded-full border border-emerald-500/30 shrink-0"
                      />
                    ) : (
                      <span className="w-10 h-10 rounded-full bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 font-bold flex items-center justify-center shrink-0">
                        {user.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-white truncate">
                        {user.name}
                      </span>
                      <span className="block text-[11px] sm:text-xs text-slate-400 truncate">
                        {user.email}
                      </span>
                    </span>
                    <ArrowRight className="w-4 h-4 text-emerald-300 shrink-0" />
                  </button>
                ) : (
                  <>
                    <p className="mt-3.5 text-xs sm:text-sm text-slate-400 leading-relaxed">
                      ចូលដោយគណនី Google ដើម្បីរក្សាទុកប្រវត្តិវីដេអូ និងសិទ្ធិ Pro របស់អ្នក។
                    </p>

                    <div className="mt-4">
                      {authConfig?.configured && authConfig.clientId ? (
                        <GoogleSignInButton
                          clientId={authConfig.clientId}
                          onToken={handleToken}
                          onUnavailable={(text) => setStatus({ kind: 'error', text })}
                          disabled={busy}
                        />
                      ) : authConfig ? (
                        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3.5 flex items-start gap-2.5">
                          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                          <p className="text-[11px] sm:text-xs text-amber-200 leading-relaxed">
                            Google sign-in មិនទាន់បានភ្ជាប់ទេ។ ត្រូវការ{' '}
                            <span className="font-semibold">GOOGLE_CLIENT_ID</span> ក្នុង
                            Settings → Environment នៃ Render។
                          </p>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span className="inline-block w-3.5 h-3.5 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin" />
                          កំពុងពិនិត្យ Google sign-in…
                        </div>
                      )}
                    </div>

                    {busy && (
                      <p className="mt-3 flex items-center justify-center gap-2 text-xs text-emerald-300">
                        <span className="inline-block w-3.5 h-3.5 border-2 border-emerald-400/40 border-t-emerald-400 rounded-full animate-spin" />
                        កំពុងរក្សាទុកគណនី…
                      </p>
                    )}

                    {!originRegistered && (
                      <p className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-[11px] sm:text-xs text-amber-200 leading-relaxed">
                        ដែននេះនៅទីតាំង{' '}
                        <span className="font-semibold">{origin}</span> មិនទាន់បានចុះឈ្មោះជាមួយ Google ទេ — ការចូលនឹងបង្ហាញ
                        «origin_mismatch»។ សូមប្រើ{' '}
                        <a
                          href={CANONICAL_ORIGIN}
                          className="font-semibold underline hover:text-amber-100"
                        >
                          khmerdub-ai.pages.dev
                        </a>
                      </p>
                    )}

                    <p className="mt-3.5 flex items-start gap-1.5 text-[11px] text-slate-500 leading-relaxed">
                      <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-400/80" />
                      យើងរក្សាទុកតែឈ្មោះ និងអ៊ីមែល — គ្មានលេខសម្ងាត់ គ្មានកាត។
                      វីដេអូ ប្រវត្តិ និងចំនួនប្រើប្រាស់របស់អ្នក រក្សាទុកដោយឡែកតាមគណនីនីមួយៗ។
                    </p>
                  </>
                )}

                {status && (
                  <p
                    className={`mt-3 flex items-start gap-1.5 text-[11px] sm:text-xs leading-relaxed ${
                      status.kind === 'saved'
                        ? 'text-emerald-300'
                        : status.kind === 'error'
                          ? 'text-rose-300'
                          : 'text-slate-400'
                    }`}
                    role="status"
                  >
                    {status.kind === 'saved' && (
                      <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    )}
                    <span>{status.text}</span>
                  </p>
                )}

                {!user && (
                  <button
                    type="button"
                    onClick={backToStart}
                    className="mt-4 inline-flex items-center gap-1.5 text-[11px] sm:text-xs text-slate-500 hover:text-slate-300 transition-colors min-h-[32px]"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    ត្រឡប់ក្រោយ
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
