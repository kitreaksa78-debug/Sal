import { JobRecord, SystemConfigStatus } from '../types';

// The API normally lives on the same origin (dev + Freebuff preview).
// A static host such as Cloudflare Pages can either be given a remote API at
// build time via VITE_API_BASE_URL, or reach it through the Pages Function
// proxy in functions/api/[[path]].js (API_BACKEND_URL).
const BUILD_ENV =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const RAW_API_BASE = (BUILD_ENV.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export const API_BASE = RAW_API_BASE ? `${RAW_API_BASE}/api` : '/api';

/**
 * An API call that failed, carrying the HTTP status so callers can tell a
 * refused request apart from an unreachable server.
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Upload a video or an audio file and start separating it.
 *
 * The multipart field is still called `video` — that is the field name the
 * server reads — but what arrives can be a bare audio file, which is exactly
 * what "separate the singing from the music" is applied to.
 */
export async function uploadSeparationJob(
  file: File,
  onUploadProgress?: (pct: number) => void
): Promise<{ jobId: string; job: JobRecord }> {
  return uploadJob(file, 'separate', onUploadProgress);
}

/**
 * Upload a recording and let Gemini listen to it so the noise can be cut out.
 *
 * Same endpoint and same multipart field as a separation; the extra `mode`
 * field picks the cleanup pipeline on the server.
 */
export async function uploadCleanupJob(
  file: File,
  onUploadProgress?: (pct: number) => void
): Promise<{ jobId: string; job: JobRecord }> {
  return uploadJob(file, 'clean', onUploadProgress);
}

async function uploadJob(
  file: File,
  mode: 'separate' | 'clean',
  onUploadProgress?: (pct: number) => void
): Promise<{ jobId: string; job: JobRecord }> {
  const formData = new FormData();
  formData.append('video', file);
  formData.append('mode', mode);

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
          reject(new ApiError(errData.error || `Server responded with ${xhr.status}`, xhr.status));
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

/**
 * Ask the server to stop a job that is still processing. The pipeline checks
 * the flag between steps, so the response may arrive while the run is winding
 * down — the SSE stream then reports the final cancelled state.
 */
export async function cancelJob(
  jobId: string
): Promise<{ ok: boolean; status?: string; cancelling?: boolean; cancelled?: boolean }> {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    status?: string;
    cancelling?: boolean;
    cancelled?: boolean;
    error?: string;
  };
  if (!res.ok) throw new ApiError(data.error || 'Failed to cancel job', res.status);
  return { ok: Boolean(data.ok), status: data.status, cancelling: data.cancelling, cancelled: data.cancelled };
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

/**
 * One URL per deliverable: `vocals` (the spoken dialogue and the singing, with
 * no music under it) or `music` (everything that is not a human voice), as an
 * MP3 — or, when the upload had a picture, `mp4` plays that same stem over the
 * original video. `inline` makes the browser play it instead of saving it.
 */
export function getStemDownloadUrl(
  jobId: string,
  stem: 'vocals' | 'music',
  format: 'mp3' | 'mp4' = 'mp3',
  inline = false
): string {
  const params = new URLSearchParams({ stem, format });
  if (inline) params.set('inline', '1');
  return `${API_BASE}/jobs/${encodeURIComponent(jobId)}/download?${params.toString()}`;
}

/**
 * Build the Khmer version of a finished separation: Gemini translates the voice
 * that was pulled out of the music, and a Khmer voice sings it back over that
 * same music. Nothing is uploaded again.
 */
export async function createKhmerVersion(
  jobId: string,
  voice: 'female' | 'male' = 'female'
): Promise<JobRecord> {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/khmer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice }),
  });
  const data = (await res.json().catch(() => ({}))) as { job?: JobRecord; error?: string };
  if (!res.ok || !data.job) {
    throw new ApiError(data.error || 'មិនអាចចាប់ផ្តើមបង្កើតបទខ្មែរបានទេ។', res.status);
  }
  return data.job;
}

/** The Khmer version — MP3, or the MP4 twin when the original had a picture. */
export function getKhmerDownloadUrl(
  jobId: string,
  format: 'mp3' | 'mp4' = 'mp3',
  inline = false
): string {
  const params = new URLSearchParams({ stem: 'khmer', format });
  if (inline) params.set('inline', '1');
  return `${API_BASE}/jobs/${encodeURIComponent(jobId)}/download?${params.toString()}`;
}

// ---------------------------------------------------- stem separation service

/**
 * Where model-based stem separation runs — the Demucs API in Termux, a home
 * server, or the bundled audio-separator sidecar. The API key is never sent
 * back to the browser.
 */
export interface SeparatorConnectionView {
  url: string;
  model: string;
  path: string;
  hasApiKey: boolean;
  /**
   * `pinned` = baked into the app code (it cannot be changed from here),
   * `app` = saved from this panel, `env` = the deployment's variables.
   */
  source: 'pinned' | 'app' | 'env' | 'none';
  updatedAt: string | null;
  provider: string;
  configured: boolean;
}

export interface SeparatorTestResult {
  ok: boolean;
  /** What the service says it is, e.g. "Demucs API". */
  service: string | null;
  latencyMs: number;
  detail: string;
  model?: string;
  url?: string;
  stems?: { vocalsBytes: number; instrumentalBytes: number };
}

async function separatorError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(data.error || fallback, res.status);
}

export async function getSeparatorConnection(): Promise<SeparatorConnectionView> {
  const res = await fetch(`${API_BASE}/config/separator`);
  if (!res.ok) throw await separatorError(res, 'Failed to read the stem separation settings');
  return (await res.json()) as SeparatorConnectionView;
}

/** An empty `apiKey` keeps the stored one, so re-pointing a tunnel is one field. */
export async function saveSeparatorConnection(input: {
  url: string;
  apiKey?: string;
  model?: string;
  path?: string;
}): Promise<SeparatorConnectionView> {
  const res = await fetch(`${API_BASE}/config/separator`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await separatorError(res, 'Failed to save the stem separation settings');
  return (await res.json()) as SeparatorConnectionView;
}

/** Forget the saved connection and fall back to the deployment's env vars. */
export async function clearSeparatorConnection(): Promise<SeparatorConnectionView> {
  const res = await fetch(`${API_BASE}/config/separator`, { method: 'DELETE' });
  if (!res.ok) throw await separatorError(res, 'Failed to clear the stem separation settings');
  return (await res.json()) as SeparatorConnectionView;
}

/**
 * Check the saved service URL. The default is a short probe that answers in
 * about a second; `full = true` sends a real six-second tone through the whole
 * separation, which is slower and proves the endpoint actually separates.
 */
export async function testSeparatorConnection(full = false): Promise<SeparatorTestResult> {
  const res = await fetch(`${API_BASE}/config/separator/test${full ? '?full=1' : ''}`, {
    method: 'POST',
  });
  if (!res.ok) throw await separatorError(res, 'ការសាកល្បងបរាជ័យ (The test could not run)');
  return (await res.json()) as SeparatorTestResult;
}

// ------------------------------------------------ Gemini voice cleanup

/** One key slot: green when it can serve a request, red when it cannot. */
export interface GeminiKeyView {
  label: string;
  masked: string;
  state: 'ready' | 'cooling' | 'invalid';
  readyModels: number;
  totalModels: number;
  retryAt: string | null;
  note: string | null;
}

/** One model in the rotation, with the same green/red meaning. */
export interface GeminiModelView {
  name: string;
  state: 'ready' | 'cooling' | 'invalid';
  readyKeys: number;
  totalKeys: number;
  retryAt: string | null;
  note: string | null;
}

export interface GeminiSettingsView {
  configured: boolean;
  source: 'app' | 'env' | 'none';
  keyCount: number;
  models: GeminiModelView[];
  keys: GeminiKeyView[];
  /** The pair the next request would use, or null when every pair is red. */
  active: { keyLabel: string; model: string } | null;
  defaultModels: string[];
  savedModels: string[];
  hasSavedKeys: boolean;
  envKeyCount: number;
  maxKeys: number;
}

async function geminiError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(data.error || fallback, res.status);
}

export async function getGeminiSettings(): Promise<GeminiSettingsView> {
  const res = await fetch(`${API_BASE}/config/gemini`);
  if (!res.ok) throw await geminiError(res, 'មិនអាចអានការកំណត់ Gemini បានទេ។');
  return (await res.json()) as GeminiSettingsView;
}


/** The cleaned voice: MP3, or the MP4 twin when the upload had a picture. */
export function getCleanDownloadUrl(
  jobId: string,
  format: 'mp3' | 'mp4' = 'mp3',
  inline = false
): string {
  const params = new URLSearchParams({ stem: 'clean', format });
  if (inline) params.set('inline', '1');
  return `${API_BASE}/jobs/${encodeURIComponent(jobId)}/download?${params.toString()}`;
}

/** The untouched upload, for the before/after comparison player. */
export function getOriginalDownloadUrl(jobId: string, inline = false): string {
  const params = new URLSearchParams({ stem: 'original' });
  if (inline) params.set('inline', '1');
  return `${API_BASE}/jobs/${encodeURIComponent(jobId)}/download?${params.toString()}`;
}
