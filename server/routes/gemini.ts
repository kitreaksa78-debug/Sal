import express, { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  clearGeminiSettings,
  getGeminiModels,
  getStoredGeminiSettings,
  getGeminiKeys,
  normaliseGeminiKeys,
  normaliseGeminiModelsInput,
  saveGeminiSettings,
} from '../services/geminiSettings.js';
import {
  describeGeminiPool,
  generateGeminiJson,
  resetGeminiPoolState,
} from '../services/geminiPool.js';

const router = express.Router();

/**
 * The key list, as the browser is allowed to see it: masks and rotation state,
 * never a key. `active` names the pair the next request would use, which is what
 * the studio reads to say "using Key 2 · gemini-2.5-flash-lite".
 */
function describeSettings() {
  const pool = describeGeminiPool();
  const saved = getStoredGeminiSettings();
  const env = getGeminiKeys();

  return {
    ...pool,
    models: pool.models,
    /** True when the list came from the panel rather than the deployment env. */
    editable: true,
    hasSavedKeys: Boolean(saved?.keys.length),
    savedModels: saved?.models ?? [],
    envKeyCount: env.source === 'env' ? env.keys.length : 0,
    /** How many keys the panel accepts in one save. */
    maxKeys: 10,
  };
}

/**
 * GET /api/config/gemini
 * Which keys/models the cleanup has, and whether each slot is green or red.
 */
router.get('/', (req: Request, res: Response) => {
  res.json(describeSettings());
});

/**
 * PUT /api/config/gemini
 * `{ keys?: string | string[], models?: string | string[] }`
 *
 * An omitted `keys` keeps the stored list, so the models can be reordered
 * without retyping a secret. Sending a new list replaces the old one entirely —
 * a key that is removed here stops being used at once.
 */
router.put('/', async (req: Request, res: Response) => {
  const keys = req.body?.keys;
  const models = req.body?.models;

  if (keys !== undefined) {
    const cleaned = normaliseGeminiKeys(keys);
    if (!cleaned.length) {
      return res.status(400).json({
        error:
          'សូមបញ្ចូល Gemini API key យ៉ាងតិចមួយ (បន្ទាត់មួយក្នុងមួយ key)។ (No usable key in that list.)',
      });
    }
  }

  if (models !== undefined && normaliseGeminiModelsInput(models).length === 0) {
    return res.status(400).json({
      error: 'បញ្ជី model ទទេ។ សូមជ្រើសយ៉ាងតិចមួយ ឬទុកចោលដើម្បីប្រើលំនាំដើម។',
    });
  }

  try {
    const saved = await saveGeminiSettings({ keys, models });
    // A new key/model list deserves a clean slate: red marks belong to the slots
    // that were just replaced.
    resetGeminiPoolState();
    logger.info(`Gemini cleanup configured from the studio (${saved.keys.length} key(s))`);
    return res.json(describeSettings());
  } catch (err: any) {
    logger.error('Failed to save the Gemini settings:', err);
    return res.status(500).json({ error: 'មិនអាចរក្សាទុកការកំណត់ Gemini បានទេ។' });
  }
});

/**
 * DELETE /api/config/gemini
 * Forget the panel's list and fall back to `GEMINI_API_KEYS` from the host.
 */
router.delete('/', async (req: Request, res: Response) => {
  await clearGeminiSettings();
  resetGeminiPoolState();
  return res.json(describeSettings());
});

/**
 * POST /api/config/gemini/test
 * One tiny request through the rotation, so "does this key work?" is answered
 * before a 40-minute recording is uploaded rather than after.
 */
router.post('/test', async (req: Request, res: Response) => {
  if (!getGeminiKeys().keys.length) {
    return res.status(400).json({
      error: 'មិនទាន់មាន Gemini key ទេ។ សូមបញ្ចូល key មុននឹងសាកល្បង។',
      ...describeSettings(),
    });
  }

  const startedAt = Date.now();
  try {
    const result = await generateGeminiJson<{ ok?: boolean }>({
      prompt:
        'Reply with JSON only: {"ok": true, "role": "audio cleanup"}. Do not add anything else.',
      maxOutputTokens: 64,
      timeoutMs: 45_000,
      label: 'gemini key test',
      parse: (value) => ({ ok: (value as any)?.ok !== false }),
    });

    return res.json({
      ok: true,
      model: result.model,
      keyLabel: result.keyLabel,
      attempts: result.attempts,
      latencyMs: Date.now() - startedAt,
      detail: `ប្រើ ${result.keyLabel} · ${result.model}`,
      ...describeSettings(),
    });
  } catch (err: any) {
    return res.status(502).json({
      ok: false,
      error: err?.message || 'ការសាកល្បងបរាជ័យ។',
      latencyMs: Date.now() - startedAt,
      ...describeSettings(),
    });
  }
});

export default router;
