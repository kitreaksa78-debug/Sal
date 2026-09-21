import { JobRecord, JobSettings, SystemConfigStatus } from '../types';

// The API normally lives on the same origin (dev + Freebuff preview).
// A static host such as Cloudflare Pages can either be given a remote API at
// build time via VITE_API_BASE_URL, or reach it through the Pages Function
// proxy in functions/api/[[path]].js (API_BACKEND_URL).
const BUILD_ENV =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const RAW_API_BASE = (BUILD_ENV.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export const API_BASE = RAW_API_BASE ? `${RAW_API_BASE}/api` : '/api';

export async function uploadVideoJob(
  file: File,
  settings: JobSettings,
  onUploadProgress?: (pct: number) => void
): Promise<{ jobId: string; job: JobRecord }> {
  const formData = new FormData();
  formData.append('video', file);
  formData.append('settings', JSON.stringify(settings));

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/jobs`);

    if (onUploadProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onUploadProgress(pct);
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data);
        } catch (err) {
          reject(new Error('Invalid JSON response from server'));
        }
      } else {
        try {
          const errData = JSON.parse(xhr.responseText);
          reject(new Error(errData.error || `Server responded with ${xhr.status}`));
        } catch {
          reject(new Error(`Server error: ${xhr.status} ${xhr.statusText}`));
        }
      }
    };

    xhr.onerror = () => {
      reject(new Error('ការតភ្ជាប់បណ្តាញបរាជ័យ។ សូមពិនិត្យមើលអ៊ីនធឺណិត។ (Network connection failed)'));
    };

    xhr.send(formData);
  });
}

export async function getJob(jobId: string): Promise<JobRecord> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch job');
  }
  return await res.json();
}

export async function listJobs(): Promise<JobRecord[]> {
  const res = await fetch(`${API_BASE}/jobs`);
  if (!res.ok) {
    throw new Error('Failed to fetch jobs list');
  }
  const data = await res.json();
  return data.jobs || [];
}

export async function getSystemConfigStatus(): Promise<SystemConfigStatus> {
  const res = await fetch(`${API_BASE}/config/status`);
  if (!res.ok) {
    throw new Error('Failed to fetch system config');
  }
  return await res.json();
}

export function subscribeToJobUpdates(
  jobId: string,
  onUpdate: (job: JobRecord) => void,
  onError?: (err: any) => void
): () => void {
  const eventSource = new EventSource(`${API_BASE}/jobs/${jobId}/events`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onUpdate(data);
      if (data.status === 'completed' || data.status === 'failed') {
        eventSource.close();
      }
    } catch (e) {
      console.error('Failed to parse SSE message:', e);
    }
  };

  eventSource.onerror = (err) => {
    console.warn('SSE connection error:', err);
    if (onError) onError(err);
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}

export function getDownloadUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/download`;
}

export function getSubtitlesUrl(jobId: string, format: 'srt' | 'vtt' = 'vtt'): string {
  return `${API_BASE}/jobs/${jobId}/subtitles?format=${format}`;
}

export function getAudioDownloadUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/audio`;
}

export function getMediaFileUrl(category: 'uploads' | 'outputs', filename: string): string {
  return `${API_BASE}/files/${category}/${encodeURIComponent(filename)}`;
}

// ------------------------------------------------------------------ billing

export type Plan = 'free' | 'pro';

export interface BillingConfig {
  configured: boolean;
  webhookConfigured: boolean;
  storeName?: string;
  storeUrl?: string;
  currency?: string;
  testMode: boolean;
  product?: {
    productId: string;
    productName: string;
    variantId: string;
    isSubscription: boolean;
    interval: string | null;
    intervalCount: number | null;
  };
  missing: string[];
  checkoutUrl: string | null;
}

export interface Entitlement {
  email: string;
  plan: Plan;
  status: string;
  renewsAt?: string | null;
}

/** Cached briefly: the checkout URL only changes when the product changes. */
let billingCache: { data: BillingConfig; at: number } | null = null;

export async function getBillingConfig(force = false): Promise<BillingConfig> {
  if (!force && billingCache && Date.now() - billingCache.at < 60_000) {
    return billingCache.data;
  }
  const res = await fetch(`${API_BASE}/billing/plans${force ? '?refresh=1' : ''}`);
  if (!res.ok) throw new Error('Failed to fetch billing configuration');
  const data = (await res.json()) as BillingConfig;
  billingCache = { data, at: Date.now() };
  return data;
}

export async function getEntitlement(email: string): Promise<Entitlement> {
  const res = await fetch(`${API_BASE}/billing/entitlement?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error('Failed to fetch entitlement');
  return (await res.json()) as Entitlement;
}

// ---------------------------------------------------------------------- auth

export interface SignedInUser {
  /** Google account id ("sub"). */
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
  logins: number;
  createdAt: string;
  lastLoginAt: string;
}

/** Whether Google sign-in is ready, and the public client id it needs. */
export async function getAuthConfig(): Promise<{ configured: boolean; clientId: string | null }> {
  const res = await fetch(`${API_BASE}/auth/config`);
  if (!res.ok) throw new Error('Failed to fetch auth configuration');
  const data = (await res.json()) as { google?: { configured?: boolean; clientId?: string | null } };
  return {
    configured: Boolean(data.google?.configured),
    clientId: data.google?.clientId ?? null,
  };
}

/**
 * Exchange the Google access token for a stored account. The server verifies the
 * token with Google before saving, so the browser cannot fake a sign-in.
 */
export async function signInWithGoogle(accessToken: string): Promise<SignedInUser> {
  const res = await fetch(`${API_BASE}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
  const data = (await res.json()) as { user?: SignedInUser; error?: string };
  if (!res.ok || !data.user) {
    throw new Error(data.error || 'Google sign-in failed');
  }
  return data.user;
}

/** Every saved account, newest login first. */
export async function listUsers(limit = 200): Promise<SignedInUser[]> {
  const res = await fetch(`${API_BASE}/auth/users?limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch users');
  const data = (await res.json()) as { users?: SignedInUser[] };
  return data.users || [];
}

/** Verify a purchase by the buyer's email (also used to restore access). */
export async function activatePurchase(email: string): Promise<Entitlement> {
  const res = await fetch(`${API_BASE}/billing/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = (await res.json()) as Entitlement & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Activation failed');
  return data;
}
