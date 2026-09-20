import { GoogleProfile } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Google sign-in ("Sign in with Google") configuration.
 *
 * The browser gets an ID token (a JWT) from Google Identity Services and posts
 * it here; the server then asks Google what that token means instead of trusting
 * the client. Only the client id is needed — the ID-token flow has no secret.
 * Create one at https://console.cloud.google.com/apis/credentials
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

/**
 * Verify an ID token with Google and normalise the profile. Throws when the
 * token is expired, tampered with, or was issued for another application.
 */
export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  const { clientId } = getGoogleAuthConfig();
  if (!clientId) throw new Error('Google sign-in is not configured on this server');

  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
  );
  if (!res.ok) {
    throw new Error('Google rejected the sign-in token');
  }

  const claims = (await res.json()) as Record<string, unknown>;

  if (claimString(claims, 'aud') !== clientId) {
    throw new Error('The sign-in token was issued for a different application');
  }

  const expiresAt = Number(claims.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new Error('The sign-in token has expired');
  }

  const email = claimString(claims, 'email').toLowerCase();
  const id = claimString(claims, 'sub');
  if (!email || !id) {
    throw new Error('The Google account did not provide an email address');
  }

  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

  const profile: GoogleProfile = {
    id,
    email,
    name: claimString(claims, 'name') || email.split('@')[0],
    picture: claimString(claims, 'picture') || undefined,
    emailVerified,
  };

  logger.info(`Verified Google sign-in for ${profile.email}`);
  return profile;
}
