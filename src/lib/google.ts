/**
 * Google Identity Services, loaded on demand.
 *
 * The sign-in button is ours so it matches the card; it runs Google's OAuth 2.0
 * token model, which hands the browser a short-lived access token for the account
 * the visitor picked. The server verifies that token with Google before the
 * account is stored, so the browser cannot fake a sign-in.
 */
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/** `openid` is what makes Google return the account id next to the email. */
const SCOPES = 'openid email profile';

export interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

/** The client Google gives us; calling it opens the account popup. */
export interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GoogleErrorResponse {
  type?: string;
}

interface GoogleOauth2Api {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: GoogleErrorResponse) => void;
  }) => GoogleTokenClient;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOauth2Api } };
  }
}

let scriptPromise: Promise<void> | null = null;

export function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
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

const REACH_GOOGLE_ERROR =
  'មិនអាចភ្ជាប់ទៅ Google បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត រួចព្យាយាមម្តងទៀត។';

export interface GoogleTokenClientConfig {
  clientId: string;
  /** The Google access token, ready to be verified by our server. */
  onToken: (accessToken: string) => void;
  onError: (message: string) => void;
}

/**
 * Builds the token client. Returns `null` until the Google script has loaded, so
 * callers can show a "connecting…" state instead of a dead button.
 */
export function createGoogleTokenClient({
  clientId,
  onToken,
  onError,
}: GoogleTokenClientConfig): GoogleTokenClient | null {
  const api = window.google?.accounts?.oauth2;
  if (!api) return null;

  return api.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (response) => {
      if (response.access_token) {
        onToken(response.access_token);
        return;
      }
      onError(response.error_description || response.error || REACH_GOOGLE_ERROR);
    },
    error_callback: (error) => {
      switch (error?.type) {
        // Dismissing the popup is a normal user action, not an error to report.
        case 'popup_closed':
          return;
        case 'popup_failed_to_open':
          onError('កម្មវិធីរុករកបានបិទផ្ទាំង Google។ សូមអនុញ្ញាត popup រួចព្យាយាមម្តងទៀត។');
          return;
        case 'idpiframe_initialization_failed':
          onError('ដែននេះមិនទាន់បានអនុញ្ញាតក្នុង Google Console ទេ (Authorized JavaScript origins)។');
          return;
        default:
          onError(REACH_GOOGLE_ERROR);
      }
    },
  });
}
