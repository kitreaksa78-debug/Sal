import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Crown, Mail, Sparkles, Zap } from 'lucide-react';
import { getUsageStats } from '../lib/usage';
import { CONTACT_EMAIL, gmailComposeUrl } from '../lib/contact';
import { getAuthConfig, signInWithGoogle, SignedInUser } from '../lib/api';
import { GoogleSignInButton } from './GoogleSignInButton';

interface WelcomePageProps {
  /**
   * Leaves the welcome screen for the dubbing studio. The app navigation (tab
   * bar) only shows once the visitor is inside the app.
   */
  onEnterApp?: () => void;
  /** The Google account signed in on this device, if any. */
  user?: SignedInUser | null;
  /** Called after a successful Google sign-in so the app can remember it. */
  onSignedIn?: (user: SignedInUser) => void;
}

type Status = { kind: 'saved' | 'error' | 'info'; text: string };

export const WelcomePage: React.FC<WelcomePageProps> = ({ onEnterApp, user, onSignedIn }) => {
  // Step 1: only "Get started". Step 2 (after the click): sign in with Google.
  const [showContact, setShowContact] = useState(false);
  const [authConfig, setAuthConfig] = useState<{ configured: boolean; clientId: string | null } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const stats = getUsageStats();

  // Only ask the server about Google sign-in once the visitor is past the CTA.
  useEffect(() => {
    if (!showContact || authConfig) return;

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
  }, [showContact, authConfig]);

  const handleCredential = async (credential: string) => {
    setBusy(true);
    setStatus(null);

    try {
      const account = await signInWithGoogle(credential);
      onSignedIn?.(account);
      setStatus({
        kind: 'saved',
        text: `បានរក្សាទុកគណនីរបស់អ្នករួចរាល់ ✓ (${account.email})`,
      });
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

  const openGmail = () => {
    window.open(
      gmailComposeUrl(user ? { name: user.name, email: user.email } : null),
      '_blank',
      'noopener,noreferrer'
    );
  };

  return (
    <div className="animate-in fade-in duration-300">
      <section className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-emerald-950/40 via-[#0b1220] to-[#0b0f17] px-5 py-14 sm:px-10 sm:py-20">
        <div className="pointer-events-none absolute -top-24 -right-20 h-60 w-60 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -left-20 h-60 w-60 rounded-full bg-teal-500/10 blur-3xl" />

        <div className="relative mx-auto max-w-2xl text-center">
          <div className="inline-flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[11px] sm:text-xs font-semibold text-emerald-300">
            <Sparkles className="w-3.5 h-3.5" />
            <span>វេទិកាបកប្រែវីដេអូ និងបញ្ចូលសំឡេងខ្មែរ AI</span>
          </div>

          <h2 className="mt-5 text-2xl sm:text-5xl font-bold text-white tracking-tight leading-snug">
            សូមស្វាគមន៍មកកាន់ <span className="text-emerald-400">KhmerDub AI</span>
          </h2>

          <p className="mt-3 text-sm sm:text-lg text-slate-300 leading-relaxed">
            បំលែងវីដេអូភាសាបរទេស ទៅជាវីដេអូភាសាខ្មែរ ដោយរក្សាភ្លេង និងសំឡេងបរិយាកាសដើម។
          </p>

          {/* Step 1 — the only call to action on arrival */}
          {!showContact && (
            <div className="mt-8">
              <button
                type="button"
                onClick={() => setShowContact(true)}
                className="inline-flex items-center justify-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white font-bold text-base sm:text-lg shadow-lg shadow-emerald-500/25 active:scale-95 transition-all min-h-[56px] w-full sm:w-auto"
              >
                <Zap className="w-5 h-5 shrink-0" />
                <span>Get started</span>
                <ArrowRight className="w-5 h-5 shrink-0" />
              </button>

              <p className="mt-4 text-[11px] sm:text-xs text-slate-400">
                {stats.unlimited ? (
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
          {showContact && (
            <div className="mt-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="rounded-2xl border border-slate-800 bg-[#111827]/80 p-5 sm:p-6 text-left">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 flex items-center justify-center shrink-0">
                    <Mail className="w-5 h-5" />
                  </div>
                  <h3 className="text-base sm:text-lg font-bold text-white">
                    {user ? 'គណនី Google របស់អ្នក' : 'ចូលដោយ Google'}
                  </h3>
                </div>

                {user ? (
                  /* Signed in — show the saved account. */
                  <div className="mt-4 flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5">
                    {user.picture ? (
                      <img
                        src={user.picture}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-10 h-10 rounded-full border border-emerald-500/30 shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 font-bold flex items-center justify-center shrink-0">
                        {user.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{user.name}</p>
                      <p className="text-[11px] sm:text-xs text-slate-400 truncate">{user.email}</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="mt-3 text-xs sm:text-sm text-slate-400 leading-relaxed">
                      ចូលដោយគណនី Google ដើម្បីរក្សាទុកគណនីរបស់អ្នក — ឈ្មោះ និងអ៊ីមែលនឹងត្រូវបាន
                      រក្សាទុកដោយស្វ័យប្រវត្តិ។
                    </p>

                    <div className="mt-5">
                      {authConfig?.configured && authConfig.clientId ? (
                        <GoogleSignInButton
                          clientId={authConfig.clientId}
                          onCredential={handleCredential}
                          onUnavailable={(text) => setStatus({ kind: 'error', text })}
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
                        <p className="text-xs text-slate-500">កំពុងពិនិត្យ Google sign-in…</p>
                      )}
                    </div>

                    {busy && (
                      <p className="mt-3 text-xs text-emerald-300">កំពុងរក្សាទុកគណនី…</p>
                    )}
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

                {/* The one other Google action: a prefilled Gmail draft. */}
                <button
                  type="button"
                  onClick={openGmail}
                  className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-slate-700 text-slate-300 text-xs sm:text-sm font-medium hover:bg-slate-800/60 hover:text-white active:scale-95 transition-all min-h-[48px]"
                >
                  <Mail className="w-4 h-4 shrink-0" />
                  <span>Contact with Google · {CONTACT_EMAIL}</span>
                </button>
              </div>

              {/* The only way off this screen — the tab bar stays hidden until here */}
              {onEnterApp && (
                <button
                  type="button"
                  onClick={onEnterApp}
                  className="mt-4 mx-auto flex items-center gap-1.5 text-xs sm:text-sm font-medium text-emerald-300 hover:text-emerald-200 transition-colors underline-offset-4 hover:underline"
                >
                  <span>ចូលទៅស្ទូឌីយោ</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
