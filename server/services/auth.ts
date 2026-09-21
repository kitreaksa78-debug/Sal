import { GoogleProfile } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Google sign-in ("Sign in with Google") configuration.
 *
 * The browser signs in with Google Identity Services and posts the resulting
 * token here; the server then asks Google what that token means instead of
 * trusting the client. Only the client id is needed — neither flow takes a
 * secret. Create one at https://console.cloud.google.com/apis/credentials
 * (type: Web application, authorised JavaScript origin: the site's URL).
 */
export interface GoogleAuthConfig {
  configured: boolean;
  clientId: string | null;
}

export function getGoogleAuthConfig(): GoogleAuthConfig {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  return { configured: Boolean(clientId), clientId: clientId || null };
}

function claimString(claims: Record<string, unknown>, key: string): string {
  const value = claims[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Turn Google's claims into the profile we store, rejecting incomplete ones. */
function normaliseProfile(claims: Record<string, unknown>): GoogleProfile {
  const email = claimString(claims, 'email').toLowerCase();
  const id = claimString(claims, 'sub');
  if (!email || !id) {
    throw new Error('The Google account did not provide an email address');
  }

  return {
    id,
    email,
    name: claimString(claims, 'name') || email.split('@')[0],
    picture: claimString(claims, 'picture') || undefined,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
  };
}

async function readClaims(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(what);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Verify an ID token with Google and normalise the profile. Throws when the
 * token is expired, tampered with, or was issued for another application.
 */
export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  const { clientId } = getGoogleAuthConfig();
  if (!clientId) throw new Error('Google sign-in is not configured on this server');

  const claims = await readClaims(
    await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`),
    'Google rejected the sign-in token'
  );

  if (claimString(claims, 'aud') !== clientId) {
    throw new Error('The sign-in token was issued for a different application');
  }

  const expiresAt = Number(claims.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new Error('The sign-in token has expired');
  }

  const profile = normaliseProfile(claims);
  logger.info(`Verified Google sign-in for ${profile.email}`);
  return profile;
}

/**
 * Verify an OAuth 2.0 access token minted by Google Identity Services for this
 * application, then read the profile behind it. Google is the only authority
 * here: the token is checked with Google, so the browser cannot fake a sign-in.
 */
export async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleProfile> {
  const { clientId } = getGoogleAuthConfig();
  if (!clientId) throw new Error('Google sign-in is not configured on this server');

  // 1. Token info proves the token is Google's and was minted for our app.
  const info = await readClaims(
    await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`),
    'Google rejected the sign-in token'
  );

  if (claimString(info, 'aud') !== clientId) {
    throw new Error('The sign-in token was issued for a different application');
  }

  const expiresIn = Number(info.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn <= 0) {
    throw new Error('The sign-in token has expired');
  }

  // 2. The profile (name, picture) hangs off the same token.
  const claims = await readClaims(
    await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    'Google did not return the account profile'
  );

  const profile = normaliseProfile(claims);
  logger.info(`Verified Google sign-in for ${profile.email}`);
  return profile;
}
