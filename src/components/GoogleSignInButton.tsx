import React, { useEffect, useRef, useState } from 'react';
import { GoogleMark } from './GoogleMark';
import { createGoogleTokenClient, loadGoogleScript, type GoogleTokenClient } from '../lib/google';

interface GoogleSignInButtonProps {
  clientId: string;
  /** Called with the Google access token for the account the visitor picked. */
  onToken: (accessToken: string) => void;
  onUnavailable?: (message: string) => void;
  disabled?: boolean;
  label?: string;
}

/**
 * Google's own `<iframe>` button ignores our theme (and can stretch into a wide
 * white bar on phones), so the button is ours and Google's OAuth token model does
 * the work behind it.
 */
export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({
  clientId,
  onToken,
  onUnavailable,
  disabled = false,
  label = 'បន្តជាមួយ Google',
}) => {
  const clientRef = useRef<GoogleTokenClient | null>(null);
  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(false);

  // Keep the newest callbacks without re-creating Google's client.
  const tokenHandler = useRef(onToken);
  const errorHandler = useRef(onUnavailable);

  useEffect(() => {
    tokenHandler.current = onToken;
    errorHandler.current = onUnavailable;
  }, [onToken, onUnavailable]);

  useEffect(() => {
    let cancelled = false;

    loadGoogleScript()
      .then(() => {
        if (cancelled) return;
        const client = createGoogleTokenClient({
          clientId,
          onToken: (token) => {
            setWaiting(false);
            tokenHandler.current(token);
          },
          onError: (message) => {
            setWaiting(false);
            errorHandler.current?.(message);
          },
        });
        clientRef.current = client;
        setReady(Boolean(client));
      })
      .catch(() => {
        if (!cancelled) {
          errorHandler.current?.(
            'មិនអាចភ្ជាប់ទៅ Google បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត រួចព្យាយាមម្តងទៀត។ (Could not reach Google)'
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const handleClick = () => {
    const client = clientRef.current;
    if (!client) {
      errorHandler.current?.('Google មិនទាន់រួចរាល់ទេ។ សូមរង់ចាំមួយភ្លែត រួចព្យាយាមម្តងទៀត។');
      return;
    }
    // requestAccessToken must run inside the click to count as a user gesture.
    setWaiting(true);
    client.requestAccessToken();
  };

  const busy = waiting || !ready;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || !ready}
      aria-busy={busy}
      className="w-full inline-flex items-center justify-center gap-3 rounded-xl bg-white px-5 min-h-[52px] text-sm sm:text-base font-semibold text-slate-800 shadow-lg shadow-black/30 transition hover:bg-slate-50 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {ready ? (
        <GoogleMark className="w-5 h-5 shrink-0" />
      ) : (
        <span className="inline-block w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin shrink-0" />
      )}
      <span>{ready ? label : 'កំពុងភ្ជាប់ Google…'}</span>
    </button>
  );
};
