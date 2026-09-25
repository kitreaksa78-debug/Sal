import express, { Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { requireSession } from '../middleware/session.js';
import { isAppOwner } from '../services/accounts.js';
import { SessionRecord } from '../types.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';
import {
  clearSeparatorConnection,
  getSeparatorConnection,
  saveSeparatorConnection,
} from '../services/separatorSettings.js';
import {
  SeparatorTestReport,
  describeRemoteService,
  getAudioSeparationProvider,
  testRemoteSeparation,
} from '../services/audioSeparation.js';

const router = express.Router();

/**
 * The stem service is infrastructure, not a per-account feature: only the app
 * owner may look at it or change where the pipeline sends audio.
 *
 * `isAppOwner` is the right check here, not the bare `OWNER_EMAILS` allowlist:
 * it is the same answer the account already gets from `/api/usage`, and a
 * deployment that never set `OWNER_EMAILS` still has exactly one owner (the
 * first account) — otherwise the panel would be visible but every request from
 * it would come back 403, which is precisely the setup the owner needs to be
 * able to do alone.
 */
async function requireAdmin(req: Request, res: Response): Promise<SessionRecord | null> {
  const session = await requireSession(req, res);
  if (!session) return null;
  if (!(await isAppOwner(session))) {
    res.status(403).json({
      error: 'តែគណនី Admin ទេដែលអាចកំណត់ម៉ាស៊ីនញែកភ្លេងបាន។ (Admin only.)',
    });
    return null;
  }
  return session;
}

/** Never send the key itself to a browser — only whether one is stored. */
function describeConnection() {
  const connection = getSeparatorConnection();
  const provider = getAudioSeparationProvider();
  return {
    url: connection.url,
    model: connection.model,
    path: connection.path,
    hasApiKey: Boolean(connection.apiKey),
    source: connection.source,
    updatedAt: connection.updatedAt ?? null,
    provider: provider.name,
    configured: provider.isConfigured(),
  };
}

/**
 * GET /api/config/separator
 * What the pipeline is currently using, and which provider it resolved to.
 */
router.get('/', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  res.json(describeConnection());
});

/**
 * PUT /api/config/separator
 * Point the pipeline at a stem service (e.g. the Demucs API in Termux).
 *
 * `{ url, apiKey?, model?, path? }` — an omitted or empty `apiKey` keeps the one
 * already saved, which is what makes re-pointing a phone tunnel a one-field edit.
 */
router.put('/', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  const url = String(req.body?.url ?? '')
    .trim()
    .replace(/\/+$/, '');

  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    return res.status(400).json({
      error:
        'URL មិនត្រឹមត្រូវទេ — ត្រូវចាប់ផ្តើមដោយ http:// ឬ https://។ (The URL must start with http:// or https://)',
    });
  }

  try {
    const saved = await saveSeparatorConnection({
      url,
      apiKey: req.body?.apiKey === undefined ? undefined : String(req.body.apiKey).trim(),
      model: req.body?.model === undefined ? undefined : String(req.body.model).trim(),
      path: req.body?.path === undefined ? undefined : String(req.body.path).trim(),
    });
    logger.info(`Stem service set to ${saved.url} by ${session.email}`);
    return res.json(describeConnection());
  } catch (err: any) {
    logger.error('Failed to save the stem service connection:', err);
    return res.status(500).json({ error: 'មិនអាចរក្សាទុកការកំណត់បានទេ។ (Could not save the settings.)' });
  }
});

/**
 * DELETE /api/config/separator
 * Forget the website override and fall back to the deployment's env vars.
 */
router.delete('/', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  await clearSeparatorConnection();
  logger.info(`Stem service override cleared by ${session.email}`);
  res.json(describeConnection());
});

/**
 * Build a short test tone: a 440 Hz "voice" and a 110 Hz "music" tone, so the
 * separation has genuinely distinct content to work with. FFmpeg is already
 * bundled with the app, so this needs nothing extra.
 */
async function createTestTone(targetDir: string): Promise<string> {
  const target = path.join(targetDir, 'stems-test.wav');
  await FFmpegHelper.execute([
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=6',
    '-f', 'lavfi',
    '-i', 'sine=frequency=110:duration=6',
    '-filter_complex',
    '[0:a]volume=0.9[tone];[1:a]volume=0.4[mus];[tone][mus]amix=inputs=2:duration=longest,aresample=44100,aformat=channel_layouts=stereo[out]',
    '-map', '[out]',
    '-acodec', 'pcm_s16le',
    target,
  ]);
  return target;
}

/**
 * POST /api/config/separator/test[?full=1]
 *
 * Default: one short probe of the saved URL — the answer arrives in about a
 * second when the phone's tunnel is up, and gives up in a few when it is not.
 * That is what the owner wants when they just pasted a new tunnel URL.
 *
 * `?full=1` keeps the end-to-end run: a six-second tone through the real
 * separation, because "reachable but the endpoint is wrong" is exactly the kind
 * of failure a plain probe hides.
 */
router.post('/test', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  const connection = getSeparatorConnection();
  if (!connection.url) {
    return res.status(400).json({
      error: 'មិនទាន់បានដាក់ URL ទេ។ (Save a service URL first.)',
    });
  }

  const full = req.query.full === '1' || req.query.full === 'true';

  if (!full) {
    const startedAt = Date.now();
    const service = await describeRemoteService(connection.url, connection.apiKey, 4_000).catch(
      () => null
    );
    const latencyMs = Date.now() - startedAt;

    if (!service) {
      logger.info(
        `Stem service quick test by ${session.email}: unreachable (${latencyMs}ms) ${connection.url}`
      );
      return res.json({
        ok: false,
        service: null,
        latencyMs,
        detail:
          'មិនអាចទាក់ទង Demucs API បានទេ។ សូមបើក tunnel លើទូរស័ព្ទ ឬ paste URL ថ្មី រួចសាកល្បងម្តងទៀត។ (No answer within 4 seconds.)',
        url: connection.url,
      });
    }

    logger.info(
      `Stem service quick test by ${session.email}: ok (${latencyMs}ms) ${service} — ${connection.url}`
    );
    return res.json({
      ok: true,
      service,
      latencyMs,
      detail: `APIឆ្លើយតបក្នុង ${latencyMs} ms។ (Quick probe only — use the full test to send real audio.)`,
      url: connection.url,
    });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-test-'));
  try {
    const service = await describeRemoteService(connection.url, connection.apiKey).catch(() => null);
    const tone = await createTestTone(tempDir);
    const report: SeparatorTestReport = await testRemoteSeparation(tone, tempDir);

    logger.info(
      `Stem service test by ${session.email}: ${report.ok ? 'ok' : 'failed'} (${report.latencyMs}ms) ${report.detail}`
    );

    return res.json({ ...report, service: report.service ?? service, url: connection.url });
  } catch (err: any) {
    logger.error('Stem service test crashed:', err);
    return res.status(500).json({
      error: err?.message || 'ការសាកល្បងបរាជ័យ។ (The test could not run.)',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

export default router;
