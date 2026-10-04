import express, { Request, Response } from 'express';
import { requireSession } from '../middleware/session.js';
import { isAppOwner } from '../services/accounts.js';
import { SessionRecord } from '../types.js';
import { logger } from '../utils/logger.js';
import {
  NLLB_HF_MODEL,
  NLLB_TRANSLATION_MODEL,
  clearNllbConnection,
  describeNllbService,
  getNllbConnection,
  isNllbConfigured,
  looksLikeStemService,
  nllbTranslateLines,
  saveNllbConnection,
} from '../services/nllbProvider.js';

const router = express.Router();

/**
 * The translation engine belongs to the whole app, so only the owner may look at
 * it or change where the pipeline sends dialogue. Same rule as the stem service:
 * `isAppOwner` still gives one owner to a deployment that never set
 * `OWNER_EMAILS`.
 */
async function requireAdmin(req: Request, res: Response): Promise<SessionRecord | null> {
  const session = await requireSession(req, res);
  if (!session) return null;
  if (!(await isAppOwner(session))) {
    res.status(403).json({
      error: 'តែគណនី Admin ទេដែលអាចកំណត់ម៉ាស៊ីនបកប្រែបាន។ (Admin only.)',
    });
    return null;
  }
  return session;
}

/** Never send the key itself to a browser — only whether one is stored. */
function describeConnection() {
  const connection = getNllbConnection();
  return {
    url: connection.url,
    hasApiKey: Boolean(connection.apiKey),
    source: connection.source,
    updatedAt: connection.updatedAt ?? null,
    provider: 'nllb',
    model: NLLB_TRANSLATION_MODEL,
    hfModel: NLLB_HF_MODEL,
    configured: isNllbConfigured(),
  };
}

/** GET /api/config/nllb — what the pipeline uses to translate, and where it came from. */
router.get('/', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  res.json(describeConnection());
});

/**
 * PUT /api/config/nllb — point the pipeline at a translation service.
 * `{ url, apiKey? }`; an omitted or empty `apiKey` keeps the one already saved,
 * which is what makes re-pointing a Colab tunnel a one-field edit.
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
    const saved = await saveNllbConnection({
      url,
      apiKey: req.body?.apiKey === undefined ? undefined : String(req.body.apiKey).trim(),
    });
    logger.info(`NLLB translation service set to ${saved.url} by ${session.email}`);
    return res.json(describeConnection());
  } catch (err: any) {
    logger.error('Failed to save the NLLB service connection:', err);
    return res.status(500).json({ error: 'មិនអាចរក្សាទុកការកំណត់បានទេ។ (Could not save the settings.)' });
  }
});

/** DELETE /api/config/nllb — forget the website override, fall back to env vars. */
router.delete('/', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  await clearNllbConnection();
  logger.info(`NLLB translation service override cleared by ${session.email}`);
  res.json(describeConnection());
});

/**
 * POST /api/config/nllb/test
 *
 * Two checks in one answer: the service must be reachable (`GET /`), and it must
 * actually translate. The second one matters because a reachable-but-wrong
 * endpoint — the Demucs tunnel pasted into the translation card, say — answers
 * `/` fine and then fails every real block.
 */
router.post('/test', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  const connection = getNllbConnection();
  if (!connection.url) {
    return res.status(400).json({
      error: 'មិនទាន់បានដាក់ URL ទេ។ (Save a service URL first.)',
    });
  }

  const startedAt = Date.now();
  const service = await describeNllbService(connection.url, connection.apiKey, 6_000).catch(() => null);
  const latencyMs = Date.now() - startedAt;

  if (!service) {
    logger.info(
      `NLLB quick test by ${session.email}: unreachable (${latencyMs}ms) ${connection.url}`
    );
    return res.json({
      ok: false,
      service: null,
      latencyMs,
      detail:
        'មិនអាចទាក់ទង NLLB API បានទេ។ សូមបើក NLLB លើ Colab រួច paste URL ថ្មី រួចសាកល្បងម្តងទៀត។ (No answer within 6 seconds.)',
      url: connection.url,
    });
  }

  if (looksLikeStemService(service)) {
    logger.info(`NLLB quick test by ${session.email}: wrong service (${connection.url})`);
    return res.json({
      ok: false,
      service: `${service.service} · ${service.model}${service.device ? ` · ${service.device}` : ''}`,
      latencyMs,
      detail:
        'URL នេះជាម៉ាស៊ីនញែកភ្លេង (Demucs) មិនមែន NLLB API ទេ។ សូមដាក់ URL របស់ NLLB API វិញ។ (This URL is the stem/Demucs service, not the NLLB translation API — paste the NLLB URL instead.)',
      url: connection.url,
    });
  }

  try {
    const probe = await nllbTranslateLines(
      connection.url,
      connection.apiKey,
      [{ id: 'probe', text: 'Hello, how are you today?' }],
      'eng_Latn'
    );
    const sample = (probe.get('probe') || '').trim();
    if (!sample) {
      return res.json({
        ok: false,
        service: `${service.service} · ${service.model}${service.device ? ` · ${service.device}` : ''}`,
        latencyMs,
        detail:
          'API ឆ្លើយតប តែបកប្រែចេញទទេ។ សាកបើក API ឡើងវិញក្នុង Colab។ (The service answered but translated nothing.)',
        url: connection.url,
      });
    }

    logger.info(
      `NLLB test by ${session.email}: ok (${latencyMs}ms) ${service.service} ${service.device}`
    );
    return res.json({
      ok: true,
      service: `${service.service} · ${service.model}${service.device ? ` · ${service.device}` : ''}`,
      latencyMs,
      detail: `បកប្រែបាន៖ “${sample}”`,
      sample,
      url: connection.url,
    });
  } catch (err: any) {
    logger.warn('NLLB translate test failed:', err);
    return res.json({
      ok: false,
      service: `${service.service} · ${service.model}${service.device ? ` · ${service.device}` : ''}`,
      latencyMs,
      detail: err?.message || 'ការបកប្រែសាកល្បងបរាជ័យ។ (The translation probe failed.)',
      url: connection.url,
    });
  }
});

export default router;
