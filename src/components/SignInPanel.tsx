import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, RefreshCw } from 'lucide-react';
import { getAuthConfig, signInWithGoogle, SignedInUser } from '../lib/api';
import { GoogleSignInButton } from './GoogleSignInButton';
import { GoogleMark } from './GoogleMark';
import {
  CANONICAL_HOST,
  CANONICAL_ORIGIN,
  DEFAULT_GOOGLE_CLIENT_ID,
  isRegisteredOrigin,
} from '../lib/google';

interface SignInPanelProps {
  /** The Google account signed in on this device, if any. */
  user?: SignedInUser | null;
  /**
   * Called after a successful Google sign-in with the stored account and the
   * session token that claims its videos, history and usage.
   */
  onSignedIn: (user: SignedInUser, token: string) => void;
}

type Status = { kind: 'saved' | 'error' | 'info'; text: string };

/**
 * The sign-in gate the studio shows while nobody is signed in.
 *
 * Every video belongs to the account that uploaded it — the server refuses an
 * upload without a session — so this is the one thing that has to be on screen
 * before the studio can work. It used to live inside a welcome screen with a
 * hero, a "Get started" step and a three-card explainer; that screen is gone, so
 * the card that does the work is all that is left, shown in the studio itself.
 */
export const SignInPanel: React.FC<SignInPanelProps> = ({ user, onSignedIn }) => {
  const [authConfig, setAuthConfig] = useState<{ configured: boolean; clientId: string | null } | null>(
    null
  );
  /** The server could not be reached — the sign-in button still works. */
  const [configFailed, setConfigFailed] = useState(false);
  const [checking, setChecking] = useState(true);
  /** Bumped by the retry button to re-run the config probe. */
  const [retryToken, setRetryToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  // Cloudflare gives every deploy its own host; Google only knows the real domain.
  const origin = typeof window === 'undefined' ? CANONICAL_ORIGIN : window.location.origin;
  const originRegistered = isRegisteredOrigin(origin);

  // Ask the server which Google client id to use.
  useEffect(() => {
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
  }, [retryToken]);

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
      onSignedIn(account, token);
      setStatus({ kind: 'saved', text: `បានរក្សាទុកគណនីរួចរាល់ ✓ (${account.email})` });
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

  return (
    <div className="mx-auto w-full max-w-md animate-in fade-in duration-300">
      <div className="rounded-2xl border border-slate-800 bg-[#111827]/80 p-5 shadow-xl shadow-black/20 backdrop-blur-sm sm:p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-md shadow-black/30">
            <GoogleMark className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-tight text-white sm:text-lg">ចូលដោយ Google</h2>
            <p className="text-[11px] text-slate-400 sm:text-xs">គ្មានលេខសម្ងាត់ · ចុចតែម្តង</p>
          </div>
        </div>

        {user ? (
          /* Signed in — the account row doubles as the way back in. */
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5">
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
              <span className="block truncate text-sm font-semibold text-white">{user.name}</span>
              <span className="block truncate text-[11px] text-slate-400 sm:text-xs">{user.email}</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-emerald-300" />
          </div>
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
                    មិនអាចទាក់ទងម៉ាស៊ីនបម្រើបានទេ។ ប៊ូតុង Google នៅដំណើរការធម្មតា — បើមិនចេញ
                    សូមព្យាយាមម្តងទៀត។
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
                  ដែននេះនៅទីតាំង <span className="font-semibold">{origin}</span> មិនទាន់បានចុះឈ្មោះជាមួយ
                  Google ទេ — ការចូលនឹងបង្ហាញ «origin_mismatch»។ សូមប្រើ{' '}
                  <a href={CANONICAL_ORIGIN} className="font-semibold underline hover:text-amber-100">
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
            {status.kind === 'saved' && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>{status.text}</span>
          </p>
        )}
      </div>
    </div>
  );
};
