import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, CheckCircle2, RefreshCw, X } from 'lucide-react';
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
  /**
   * Called after a successful Google sign-in with the stored account and the
   * session token that claims its videos, history and usage.
   */
  onSignedIn: (user: SignedInUser, token: string) => void;
  /** Closes the sheet — backdrop tap, the × button or the Escape key. */
  onClose: () => void;
}

type Status = { kind: 'saved' | 'error' | 'info'; text: string };

/**
 * The login sheet: a ChatGPT-style panel that rises from the bottom of the
 * screen when the header's "Log in" button is tapped (or when an upload asks
 * for an account), instead of a card that takes over the whole studio.
 *
 * Every video belongs to the account that uploaded it — the server refuses an
 * upload without a session — so this sheet is the one gate, kept one tap away.
 */
export const SignInPanel: React.FC<SignInPanelProps> = ({ onSignedIn, onClose }) => {
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

  // Escape closes the sheet, and the page behind it must not scroll while open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

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
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:pb-8"
      role="dialog"
      aria-modal="true"
      aria-label="ចូលគណនី"
    >
      {/* The dimmed studio behind the sheet — tap anywhere to close. */}
      <motion.button
        type="button"
        onClick={onClose}
        aria-label="បិទបង្អួចចូល"
        className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      />

      {/* The sheet itself: slides up from below the bottom edge of the screen. */}
      <motion.div
        className="scroll-slim relative flex max-h-[92vh] w-full flex-col overflow-y-auto rounded-t-3xl border border-slate-700/70 bg-[#111827] px-5 pb-7 pt-3.5 shadow-2xl shadow-black/60 sm:max-w-md sm:rounded-3xl sm:px-6 sm:pb-6 sm:pt-4"
        initial={{ y: '110%' }}
        animate={{ y: 0 }}
        exit={{ y: '110%' }}
        transition={{ type: 'spring', stiffness: 340, damping: 34, mass: 0.9 }}
      >
        {/* Grab handle, like the panel in ChatGPT's login sheet. */}
        <div className="mx-auto mb-4 h-1.5 w-10 shrink-0 rounded-full bg-slate-600/70" />

        <button
          type="button"
          onClick={onClose}
          aria-label="បិទ"
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-lg shadow-black/30">
            <GoogleMark className="h-6 w-6" />
          </span>
          <h2 className="mt-3 text-xl font-bold text-white">ចូលគណនី</h2>
          <p className="mt-1 text-xs text-slate-400 sm:text-sm">
            បន្តជាមួយ Google · គ្មានលេខសម្ងាត់ · ចុចតែម្តង
          </p>
        </div>

        <div className="mt-5 space-y-3">
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
              of leaving the sheet in a silent, endless "checking" state. */}
          {checking && (
            <p className="flex items-center justify-center gap-2 text-[11px] text-slate-400 sm:text-xs">
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

        {status && (
          <p
            className={`mt-3 flex items-start justify-center gap-1.5 text-center text-[11px] leading-relaxed sm:text-xs ${
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
      </motion.div>
    </div>
  );
};
