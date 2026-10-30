/**
 * The combined Colab service: one tunnel that answers for both APIs.
 *
 * `tools/colab/start-all.sh` starts the stem service (Demucs) and the voice
 * conversion service on one machine and puts a small gateway in front of both,
 * so the owner pastes **one** URL and **one** key instead of two. Its `/health`
 * says what it carries:
 *
 *     { "service": "colab-studio", "services": ["demucs", "voice"], … }
 *
 * Saving that block in either card therefore fills the other card too — pasting
 * the same address twice is exactly the step that gets done once and then
 * forgotten the next time the session dies.
 *
 * Only an address that says it is both is copied across: a setup that still
 * keeps the stem service on a phone and the converter on Colab must keep two
 * different addresses, and neither card may overwrite the other there.
 */

import { logger } from '../utils/logger.js';

/** Does this `/health` body name both services? */
export function isCombinedStudio(health: unknown): boolean {
  const services = (health as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return false;
  const names = services.map((name) => String(name).toLowerCase());
  return names.includes('demucs') && names.includes('voice');
}

/**
 * Ask a saved URL what it is. Short on purpose: this runs while the owner waits
 * for the save button, and a service that is slow to answer must not turn a
 * successful save into a spinner.
 */
export async function probeCombinedStudio(url: string, apiKey?: string): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(`${url}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return false;
    return isCombinedStudio(await res.json());
  } catch (err: any) {
    // A dead tunnel is not an error here — it is simply not a combined service.
    logger.info(`Combined-studio probe: ${url} did not answer (${err?.message || err})`);
    return false;
  }
}
