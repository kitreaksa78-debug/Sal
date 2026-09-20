import React, { useEffect, useRef } from 'react';

/**
 * Google Identity Services, loaded on demand. The official button renders inside
 * our card and hands back an ID token, which the server verifies with Google
 * before the account is saved.
 */
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleIdentityApi {
  initialize: (config: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
  }) => void;
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentityApi } };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load Google Identity Services'));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

interface GoogleSignInButtonProps {
  clientId: string;
  /** Called with the ID token Google produced. */
  onCredential: (credential: string) => void;
  onUnavailable?: (message: string) => void;
  text?: 'signin_with' | 'signup_with' | 'continue_with';
}

export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({
  clientId,
  onCredential,
  onUnavailable,
  text = 'continue_with',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const credentialHandler = useRef(onCredential);
  const unavailableHandler = useRef(onUnavailable);

  useEffect(() => {
    credentialHandler.current = onCredential;
    unavailableHandler.current = onUnavailable;
  });

  useEffect(() => {
    let cancelled = false;

    loadGoogleScript()
      .then(() => {
        const api = window.google?.accounts?.id;
        const container = containerRef.current;
        if (cancelled || !container) return;
        if (!api) throw new Error('Google Identity Services is unavailable');

        api.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response.credential) {
              credentialHandler.current(response.credential);
            } else {
              unavailableHandler.current?.('Google មិនបានផ្តល់ព័ត៌មានចូលទេ។ សូមព្យាយាមម្តងទៀត។');
            }
          },
        });

        container.innerHTML = '';
        api.renderButton(container, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text,
          logo_alignment: 'left',
        });
      })
      .catch(() => {
        if (!cancelled) {
          unavailableHandler.current?.(
            'មិនអាចភ្ជាប់ទៅ Google បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត។ (Could not reach Google)'
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clientId, text]);

  /* overflow-hidden keeps Google's fixed-width iframe from pushing the page wide
     on small phones. */
  return <div ref={containerRef} className="flex justify-center min-h-[44px] max-w-full overflow-hidden" />;
};
