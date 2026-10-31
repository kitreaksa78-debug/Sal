/**
 * "Is the studio actually connected right now?"
 *
 * A saved URL only says what the site was pointed at the last time somebody
 * pasted a block — a Colab quick tunnel is handed a new hostname on every run,
 * so a saved address outlives the service behind it by hours or days. The cards
 * used to read "connected" for that dead address, and the first six-minute job
 * was how the owner found out.
 *
 * This asks the service itself, once, with a short timeout, and never throws:
 * no URL, a dead tunnel, a rejected key and a wrong service are all answers a
 * badge can render, and none of them may turn a page load into an error.
 */

import { isLocalServiceUrl } from '../utils/serviceConnection.js';
import { isCombinedStudio } from './combinedStudio.js';
import { getVoiceCloneConnection } from './cloneSettings.js';
import { getSeparatorConnection } from './separatorSettings.js';

export type LiveReason =
  | 'ok'
  | 'none'
  | 'local'
  | 'unreachable'
  | 'unauthorized'
  | 'http'
  | 'wrong-service';

export interface LiveStatusReport {
  /** The service answered and calls itself a stem separator or a converter. */
  online: boolean;
  /** Separation can run there. */
  stems: boolean;
  /** Voice conversion can run there. */
  voice: boolean;
  reason: LiveReason;
  /** One sentence for the badge's tooltip and the studio's banner. */
  message: string;
  url: string | null;
  latencyMs: number;
  service: string | null;
  device: string | null;
  /** The stem model the service would use. */
  model: string | null;
  voiceModel: string | null;
  /** `false` while the converter is still fetching its weights. */
  weights: boolean | null;
  checkedAt: string;
}

/**
 * Two tabs, or the same tab polling twice, must not turn into a probe per
 * second: the answer is cached for a few seconds, keyed by what is saved.
 */
const CACHE_MS = 4_000;
let cache: { at: number; key: string; report: LiveStatusReport } | null = null;

function emptyReport(url: string | null): LiveStatusReport {
  return {
    online: false,
    stems: false,
    voice: false,
    reason: 'none',
    message: '',
    url,
    latencyMs: 0,
    service: null,
    device: null,
    model: null,
    voiceModel: null,
    weights: null,
    checkedAt: new Date().toISOString(),
  };
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function probe(url: string, apiKey: string): Promise<LiveStatusReport> {
  const base = emptyReport(url || null);

  if (!url) {
    return {
      ...base,
      message:
        'មិនទាន់បានដាក់ URL របស់ API ទេ — រត់ cell ក្នុង Colab ម្តងទៀត (វាភ្ជាប់ដោយស្វ័យប្រវត្តិ) ឬ paste URL ក្នុងកាតខាងក្រោម។ (No API URL saved yet.)',
    };
  }

  // `http://127.0.0.1:8930` only answers inside Colab; the site's host can never
  // reach it, so name the mistake instead of reporting a timeout.
  if (isLocalServiceUrl(url)) {
    return {
      ...base,
      reason: 'local',
      message:
        'URL នេះជាអាសយដ្ឋានក្នុង Colab (127.0.0.1) — សាយមិនអាចទាក់ទងបានទេ។ ប្រើ URL https://xxxx.trycloudflare.com ជំនួស។ (That is a Colab-internal address; use the tunnel URL.)',
    };
  }

  const startedAt = Date.now();
  try {
    const answer = await fetch(`${url}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    const latencyMs = Date.now() - startedAt;

    if (answer.status === 401 || answer.status === 403) {
      return {
        ...base,
        reason: 'unauthorized',
        latencyMs,
        message:
          'សេវាឆ្លើយ តែបដិសេធ API key — key ដែលរក្សាទុកមិនផ្ទឹមនឹងសេវានេះទេ។ យកប្លុកថ្មីដែល Colab បង្ហាញ (URL + API Key) មក paste ម្តងទៀត។ (The service rejected the key.)',
      };
    }

    if (!answer.ok) {
      return {
        ...base,
        reason: 'http',
        latencyMs,
        message: `សេវាឆ្លើយ HTTP ${answer.status} — វាមិនទាន់រួចរាល់ទេ។ រង់ចាំបន្តិច រួចពិនិត្យម្តងទៀត។ (The service answered ${answer.status}.)`,
      };
    }

    const payload = (await answer.json().catch(() => ({}))) as any;
    const combined = isCombinedStudio(payload);
    const service = asText(payload?.service) ?? asText(payload?.name);
    const stemsNode = (payload?.demucs ?? null) as any;
    const voiceNode = (payload?.voice ?? null) as any;

    const looksLikeStems = combined
      ? Boolean(stemsNode)
      : /\bdemucs\b|stem|separat/i.test(service ?? '');
    const looksLikeVoice = combined
      ? Boolean(voiceNode)
      : /voice|convert/i.test(service ?? '');

    if (!combined && !looksLikeStems && !looksLikeVoice) {
      return {
        ...base,
        reason: 'wrong-service',
        latencyMs,
        service,
        message:
          'URL នេះឆ្លើយ តែមិនមែនសេវាញែកសំឡេង ឬប្តូរសំឡេងទេ។ (This URL answers, but it is not the studio service.)',
      };
    }

    const device = asText(payload?.device) ?? asText(stemsNode?.device) ?? asText(voiceNode?.device);
    const model = asText(stemsNode?.model) ?? asText(payload?.model);
    const voiceModel = asText(voiceNode?.model);
    const weights = typeof voiceNode?.weights === 'boolean' ? (voiceNode.weights as boolean) : null;

    const parts: string[] = [];
    if (looksLikeStems) {
      parts.push(
        `ញែកសំឡេងរួចរាល់${model ? ` (${model})` : ''}${device ? ` · ${device}` : ''}`
      );
    }
    if (looksLikeVoice) {
      parts.push(
        `ប្តូរសំឡេងរួចរាល់${weights === false ? ' (model កំពុងទាញ)' : ''}`
      );
    }

    const message = parts.length
      ? `ភ្ជាប់រួច — ${parts.join(' · ')}។ ឆ្លើយក្នុង ${latencyMs} ms។`
      : `សេវាឆ្លើយ តែគ្មានផ្នែកណាមួយរួចរាល់ទេ។ សូមរង់ចាំ រួចពិនិត្យម្តងទៀត។ (Nothing ready yet.)`;

    return {
      online: true,
      stems: looksLikeStems,
      voice: looksLikeVoice,
      reason: 'ok',
      message,
      url,
      latencyMs,
      service: combined ? `colab-studio · ${(payload?.services ?? []).join(' + ')}` : service,
      device,
      model,
      voiceModel,
      weights,
      checkedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    return {
      ...base,
      reason: 'unreachable',
      latencyMs,
      message:
        'មិនអាចទាក់ទង API បានទេ — tunnel ឬ session របស់ Colab ប្រហែលបានបិទ។ រត់ cell ក្នុង Colab ម្តងទៀត (វាបញ្ជូន URL ថ្មីមកសាយដោយស្វ័យប្រវត្តិ)។ (No answer: the Colab session is probably gone.)',
    };
  }
}

/**
 * What the page should show. Uses the saved studio address, or the converter's
 * own address when that is the only one (a split phone/Colab setup).
 */
export async function getLiveStatus(): Promise<LiveStatusReport> {
  const stems = getSeparatorConnection();
  const voice = getVoiceCloneConnection();
  const url = stems.url || voice.url;
  const apiKey = stems.url ? stems.apiKey : voice.apiKey;

  const key = `${url}|${apiKey ? 'key' : 'no-key'}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.report;
  }

  const report = await probe(url, apiKey);
  cache = { at: Date.now(), key, report };
  return report;
}
