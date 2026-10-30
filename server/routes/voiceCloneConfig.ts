import express, { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  SERVICE_URL_LOCAL_MESSAGE,
  SERVICE_URL_REJECTED_MESSAGE,
  isLocalServiceUrl,
  normaliseServiceKey,
  normaliseServiceUrl,
} from '../utils/serviceConnection.js';
import {
  clearVoiceCloneConnection,
  getVoiceCloneConnection,
  saveVoiceCloneConnection,
} from '../services/cloneSettings.js';
import { VOICE_CLONE_KEY_MESSAGE, isVoiceCloneConfigured } from '../services/voiceClone.js';
import { probeCombinedStudio } from '../services/combinedStudio.js';
import { saveSeparatorConnection } from '../services/separatorSettings.js';

const router = express.Router();

/** Never send the key itself to a browser — only whether one is stored. */
function describeConnection() {
  const connection = getVoiceCloneConnection();
  return {
    url: connection.url,
    hasApiKey: Boolean(connection.apiKey),
    source: connection.source,
    updatedAt: connection.updatedAt ?? null,
    configured: isVoiceCloneConfigured(),
    provider: connection.url
      ? 'Voice Convert API (Colab)'
      : isVoiceCloneConfigured()
        ? 'Replicate'
        : null,
  };
}

/**
 * GET /api/config/voice-clone
 * What the next conversion would use, and which provider it resolved to.
 */
router.get('/', async (_req: Request, res: Response) => {
  res.json(describeConnection());
});

/**
 * PUT /api/config/voice-clone
 * Point the conversion at a Voice Convert API opened on a Colab GPU.
 *
 * `{ url, apiKey? }` — an omitted or empty `apiKey` keeps the one already
 * saved, which is what makes re-pointing a reopened tunnel a one-field edit.
 */
router.put('/', async (req: Request, res: Response) => {
  // Whatever Colab printed, pasted whole: the label (`URL : …`), quotes and a
  // missing scheme are all handled by the shared normaliser.
  const url = normaliseServiceUrl(req.body?.url);

  if (!url) {
    return res.status(400).json({ error: SERVICE_URL_REJECTED_MESSAGE });
  }

  try {
    const saved = await saveVoiceCloneConnection({
      url,
      apiKey:
        req.body?.apiKey === undefined ? undefined : normaliseServiceKey(req.body.apiKey),
    });
    logger.info(`Voice conversion service set to ${saved.url}`);
    // One-tunnel Colab: pasting the block in this card must set the stem service
    // too, so either card is enough to point the whole studio at one machine.
    if (await probeCombinedStudio(saved.url, saved.apiKey)) {
      await saveSeparatorConnection({ url: saved.url, apiKey: saved.apiKey });
      logger.info(`Combined studio at ${saved.url}: stem separation uses it too`);
    }
    return res.json(describeConnection());
  } catch (err: any) {
    logger.error('Failed to save the voice conversion service connection:', err);
    return res.status(500).json({ error: 'មិនអាចរក្សាទុកការកំណត់បានទេ។ (Could not save the settings.)' });
  }
});

/**
 * DELETE /api/config/voice-clone
 * Forget the website override. The hosted API (`REPLICATE_API_TOKEN`) is then
 * what the next conversion uses, if the deployment has one.
 */
router.delete('/', async (_req: Request, res: Response) => {
  await clearVoiceCloneConnection();
  logger.info('Voice conversion service override cleared');
  res.json(describeConnection());
});

/** What the service calls itself, for the "connected to …" line. */
function serviceLabel(data: any): string {
  const label = data?.service ?? data?.name ?? data?.status;
  const version = typeof data?.version === 'string' ? ` v${data.version}` : '';
  const model = typeof data?.model === 'string' ? ` · ${data.model}` : '';
  const device =
    typeof data?.device === 'string' && data.device.trim() ? ` · ${data.device.trim()}` : '';
  return typeof label === 'string' && label.trim() ? `${label.trim()}${version}${model}${device}` : '';
}

/**
 * POST /api/config/voice-clone/test
 *
 * One short probe of the saved URL: the answer arrives in about a second when
 * the tunnel is up, and gives up in a few when it is not. `/health` is gated by
 * the key, so this also separates "tunnel up but key wrong" from "tunnel down".
 */
router.post('/test', async (_req: Request, res: Response) => {
  const connection = getVoiceCloneConnection();

  if (!connection.url) {
    // No service pasted: say what the deployment would use instead, so an owner
    // with a Replicate token does not think the feature is broken.
    const hosted = isVoiceCloneConfigured();
    return res.json({
      ok: hosted,
      service: hosted ? 'Replicate' : null,
      latencyMs: 0,
      detail: hosted
        ? 'មិនទាន់មាន Voice Convert API ទេ — គេហទំព័រកំពុងប្រើសេវា hosted ជំនួស។ (No Colab API pasted: the hosted inference API is used instead.)'
        : VOICE_CLONE_KEY_MESSAGE,
    });
  }

  // `http://127.0.0.1:8930` only answers inside Colab; the website runs on a host
  // that can never reach it, so say that instead of reporting a timeout.
  if (isLocalServiceUrl(connection.url)) {
    logger.info(`Voice conversion service test: local address (${connection.url})`);
    return res.json({
      ok: false,
      service: null,
      latencyMs: 0,
      detail: SERVICE_URL_LOCAL_MESSAGE,
      url: connection.url,
    });
  }

  const startedAt = Date.now();
  try {
    const headers: Record<string, string> = connection.apiKey
      ? { Authorization: `Bearer ${connection.apiKey}` }
      : {};
    const answer = await fetch(`${connection.url}/health`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    const latencyMs = Date.now() - startedAt;

    if (answer.status === 401 || answer.status === 403) {
      logger.info(`Voice conversion service test: key rejected (${latencyMs}ms) ${connection.url}`);
      return res.json({
        ok: false,
        service: null,
        latencyMs,
        detail: connection.apiKey
          ? 'API key មិនត្រឹមត្រូវ — key ដែលរក្សាទុកមិនផ្ទឹមគ្នានឹងសេវា។ Colab បង្កើត key ថ្មីរាល់ពេលបើកសេវាថ្មី បើមិនបានកំណត់ SERVICE_KEY។ សូមយកប្លុកដែល Colab បង្ហាញមក paste ក្នុងកាតនេះ រួចរក្សាទុកម្តងទៀត។ (The service rejected the key — paste the block Colab printed and save again.)'
          : 'សេវានេះត្រូវការ API key តែកាតនេះមិនទាន់មាន key ទេ។ សូមយកប្លុកដែល Colab បង្ហាញមក paste («URL : … / API Key : …»)។ (The service requires a key this card does not have yet.)',
      });
    }

    if (!answer.ok) {
      logger.info(`Voice conversion service test: HTTP ${answer.status} ${connection.url}`);
      return res.json({
        ok: false,
        service: null,
        latencyMs,
        detail: `សេវាឆ្លើយ ${answer.status} — URL នេះប្រហែលជាមិនមែន Voice Convert API ទេ។ (The service answered ${answer.status}; this is probably not the voice conversion API.)`,
      });
    }

    const data = await answer.json().catch(() => ({}));
    const label = serviceLabel(data);
    if (/\bnllb\b|translation|translate|demucs/i.test(label)) {
      logger.info(`Voice conversion service test: wrong service (${connection.url})`);
      return res.json({
        ok: false,
        service: label,
        latencyMs,
        detail: 'URL នេះជាសេវាផ្សេង — សូមដាក់ URL របស់ Voice Convert API វិញ។ (This is a different service — paste the voice conversion API URL instead.)',
      });
    }

    logger.info(`Voice conversion service test: ok (${latencyMs}ms) ${label} — ${connection.url}`);
    return res.json({
      ok: true,
      service: label || 'Voice Convert API',
      latencyMs,
      detail: `APIឆ្លើយតបក្នុង ${latencyMs} ms — គេហទំព័រនឹងប្រើវាផ្ទាល់សម្រាប់ការប្តូរសំឡេង។ (Answered in ${latencyMs} ms; conversions will run there.)`,
      url: connection.url,
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    logger.info(`Voice conversion service test: unreachable (${latencyMs}ms) ${connection.url}`);
    return res.json({
      ok: false,
      service: null,
      latencyMs,
      detail:
        'មិនអាចទាក់ទង Voice Convert API បានទេ។ សូមបើក tab Colab ចុះ (session ដាច់ = URL ស្លាប់) រួចរត់ cell នោះម្តងទៀត ហើយ paste URL ថ្មី រួចសាកល្បងម្តងទៀត។ (No answer — the Colab session is probably dead; rerun the cell and paste the new URL.)',
      url: connection.url,
      error: err?.message || String(err),
    });
  }
});

export default router;
