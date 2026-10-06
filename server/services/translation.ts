import { DialogueSegment, JobSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import {
  NLLB_TRANSLATION_MODEL,
  floresCodeFor,
  isNllbConfigured,
  translateWithConfiguredNllb,
} from './nllbProvider.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

export interface TranslationResult {
  segments: DialogueSegment[];
  summary?: string;
}

export interface TranslationOutcome {
  segments: DialogueSegment[];
  /** Non-fatal problems (e.g. one block kept the original text) for the job warning. */
  warnings: string[];
}

export type TranslationProgressCallback = (
  completedLines: number,
  totalLines: number
) => void | Promise<void>;

/** NLLB is the only translator, so it is the only provider name there is. */
export type TranslationProviderName = 'nllb';

/**
 * How many dialogue lines go into one NLLB request.
 *
 * The Colab service is asked for one batch at a time, so a shorter block keeps
 * progress reporting honest without queueing a long tail; wider blocks amortise
 * the round trip over more lines. `TRANSLATION_CHUNK_SIZE` overrides this.
 */
const DEFAULT_CHUNK_SIZE = 32;

/**
 * How many transcript blocks are translated at the same time. Blocks are
 * separate `/translate` requests with no dependency between them, so asking a
 * couple at once keeps the Colab model fed. `TRANSLATION_CONCURRENCY` overrides
 * this.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * Khmer is U+1780-U+17FF. Thai (U+0E00-U+0E7F) and Lao (U+0E80-U+0EFF) look close
 * enough that a translator sometimes substitutes them for Khmer characters.
 */
const THAI_OR_LAO_SCRIPT = /[\u0E00-\u0E7F\u0E80-\u0EFF]/;
const KHMER_SCRIPT = /[\u1780-\u17FF]/;

export function hasWrongScript(text: string): boolean {
  return THAI_OR_LAO_SCRIPT.test(text);
}

/** Remove every Thai/Lao codepoint and collapse whitespace. Deterministic, no LLM needed. */
export function stripWrongScript(text: string): string {
  return text.replace(/[\u0E00-\u0E7F\u0E80-\u0EFF]/g, '').replace(/\s+/g, ' ').trim();
}

/** A Khmer line is usable when it has at least one Khmer character, no Thai/Lao, and is not trivial. */
export function isValidKhmer(text: string): boolean {
  const t = text.trim();
  return t.length >= 2 && KHMER_SCRIPT.test(t) && !hasWrongScript(t);
}

/** Best-effort local repair: strip Thai/Lao and keep the result only when it is still valid Khmer. */
export function sanitizeKhmer(text: string): string | null {
  const cleaned = stripWrongScript(text);
  if (cleaned && isValidKhmer(cleaned)) return cleaned;
  return null;
}

/** Written at the end of a sentence, in Latin or Khmer script. */
const ENDS_A_SENTENCE = /[.!?…។៕]["'’”)]?$|["'’”)]$/;

/**
 * Whisper's decode windows cut speech wherever its silence detector fires, which
 * regularly lands in the middle of a sentence: "I told him we should leave" /
 * "before the storm arrives". Translated one window at a time, each fragment is
 * judged on its own — the first half loses its subject, the second half loses its
 * verb — and the dub stops sounding like the line the actor actually says.
 *
 * So adjacent fragments of the same speaker are welded back together first, under
 * three conditions that keep the weld from ever crossing a real pause:
 *
 *  - they are the same speaker (so two people talking over each other stay apart);
 *  - the silence between them is short (so a new utterance after a beat stays on
 *    its own line and the mouth on screen still matches the voice);
 *  - the earlier fragment does not already end in a full stop, so a finished
 *    sentence is never glued to the next one and the subtitle cue is kept.
 *
 * Merging only ever lengthens a line inside gaps the dub already had: the welded
 * line starts where the first fragment started and ends where the last one ended,
 * so nothing moves on the timeline and no time is invented.
 */
export function mergeDialogueFragments(
  segments: DialogueSegment[],
  maxGapSeconds = Number(process.env.TRANSLATION_MERGE_GAP || '0.7'),
  maxSeconds = Number(process.env.TRANSLATION_MERGE_MAX_SECONDS || '14'),
  maxChars = Number(process.env.TRANSLATION_MERGE_MAX_CHARS || '320')
): DialogueSegment[] {
  if (segments.length < 2) return segments;

  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const merged: DialogueSegment[] = [];

  for (const segment of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...segment });
      continue;
    }

    const gap = segment.start - previous.end;
    const sameSpeaker = !previous.speaker || !segment.speaker || previous.speaker === segment.speaker;
    const previousUnfinished = !ENDS_A_SENTENCE.test(previous.text.trim());
    const shortEnough =
      segment.end - previous.start <= maxSeconds &&
      previous.text.length + segment.text.length + 1 <= maxChars;

    if (sameSpeaker && previousUnfinished && gap >= -0.05 && gap <= maxGapSeconds && shortEnough) {
      // One space joins the words; Khmer already breaks on its own.
      merged[merged.length - 1] = {
        ...previous,
        end: Math.max(previous.end, segment.end),
        text: `${previous.text.trim()} ${segment.text.trim()}`.trim(),
        khmer: previous.khmer ? `${previous.khmer} ${segment.khmer || ''}`.trim() : segment.khmer,
      };
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
}

/**
 * The translation stage runs on **NLLB-200 and nothing else**.
 *
 * The owner asked for Groq and Gemini to be taken out of translation and for
 * NLLB-200 to do the translating, served from Google Colab (every NLLB-200 needs
 * more RAM than the free Render instance has). The Colab service runs the
 * strongest preset by default (`facebook/nllb-200-3.3B`, `NLLB_MODE=best`) and
 * steps down that table when a runtime cannot hold it. So the
 * provider is no longer a choice: every block goes to the NLLB service, and
 * `TRANSLATION_PROVIDER` / `GEMINI_*` / `GROQ_TRANSLATION_*` no longer pick a
 * translator. Groq is still used for speech-to-text, which the owner kept.
 */
export function resolveTranslationProvider(): TranslationProviderName {
  return 'nllb';
}

export class KhmerDubTranslationService {
  private modelName: string;
  private provider: TranslationProviderName;
  /** Providers that actually answered a block; reported by the job's log line. */
  private answeredProviders = new Set<TranslationProviderName>();

  constructor() {
    this.provider = resolveTranslationProvider();
    // NLLB is served over HTTP, so the model name is the Colab service's model
    // rather than anything this process loads.
    this.modelName = NLLB_TRANSLATION_MODEL;
  }

  public getProviderName(): TranslationProviderName {
    return this.provider;
  }

  public getModelName(): string {
    return this.modelName;
  }

  public isConfigured(): boolean {
    return isNllbConfigured();
  }

  /** NLLB has no model rotation behind it, so there is never a fallback model. */
  public getFallbackModelNames(): string[] {
    return [];
  }

  /** NLLB is the only translator, so no service takes over when a block fails. */
  public getFallbackProviderName(): TranslationProviderName | null {
    return null;
  }

  /** How many dialogue lines go into a single NLLB request. */
  public getChunkSize(): number {
    const configured = Number(process.env.TRANSLATION_CHUNK_SIZE);
    return Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_CHUNK_SIZE;
  }

  /**
   * How many blocks are in flight at once.
   *
   * The NLLB service translates one batch at a time, so a couple of blocks in
   * flight keeps it fed without queueing a long tail; `TRANSLATION_CONCURRENCY`
   * overrides it.
   */
  public getConcurrency(): number {
    const configured = Number(process.env.TRANSLATION_CONCURRENCY);
    return Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_CONCURRENCY;
  }

  /**
   * Translates dialogue segments into natural spoken Cambodian Khmer.
   *
   * The transcript is sent to the NLLB service in blocks rather than one giant
   * request: a block is one `/translate` call, so the job can report real
   * progress and a bad block cannot discard the whole transcript.
   *
   * The blocks do not depend on each other, so they are asked at the same time
   * (see getConcurrency) and the stage costs roughly one round trip per wave
   * instead of one per block.
   */
  public async translateDialogue(
    segments: DialogueSegment[],
    settings: JobSettings,
    onProgress?: TranslationProgressCallback
  ): Promise<TranslationOutcome> {
    if (!this.isConfigured()) {
      throw new Error(
        'មិនទាន់ភ្ជាប់ NLLB API ទេ។ (No NLLB translation service is connected — open the NLLB panel and paste the Colab URL.)'
      );
    }

    if (segments.length === 0) {
      return { segments: [], warnings: [] };
    }

    // Whisper's windows are cut where its silence detector fired, which regularly
    // lands mid-sentence. Welding those fragments back together before anything
    // is translated is what lets the model read a whole thought — and keeps the
    // dub saying what the actor said instead of two halves of it.
    const ordered = mergeDialogueFragments(segments);
    const mergedCount = segments.length - ordered.length;
    if (mergedCount > 0) {
      logger.info(
        `Joined ${mergedCount} transcript fragment(s) that had been split mid-sentence: ${segments.length} line(s) -> ${ordered.length}.`
      );
    }

    const chunkSize = this.getChunkSize();
    const chunks: DialogueSegment[][] = [];
    for (let i = 0; i < ordered.length; i += chunkSize) {
      chunks.push(ordered.slice(i, i + chunkSize));
    }

    this.answeredProviders.clear();

    const translations = new Map<string, { khmer: string; emotion?: string }>();
    const warnings: string[] = [];
    // Blocks run at the same time, so the same problem (or the same failure) can be
    // reported by more than one of them; each reason is listed once.
    const warningSet = new Set<string>();
    const addWarning = (message: string) => {
      if (warningSet.has(message)) return;
      warningSet.add(message);
      warnings.push(message);
    };

    const concurrency = Math.max(1, Math.min(this.getConcurrency(), chunks.length));
    const startedAt = Date.now();
    let completedLines = 0;

    await mapWithConcurrency(chunks, concurrency, async (chunk, i) => {
      // NLLB takes one plain list of lines and answers one Khmer line per line; it
      // follows no instructions, so the block goes straight to the Colab service
      // and the deterministic passes (script sanitising, the final mapping) do the
      // rest. No prompt building, no rescue/glossary/proper-name retries.
      await this.translateChunkWithNllb(chunk, settings, translations, addWarning, i, chunks.length);
      completedLines += chunk.length;
      if (onProgress) await onProgress(completedLines, ordered.length);
    });

    const translatedSegments = ordered.map((segment) => {
      const item = translations.get(segment.id);
      let khmer = (item?.khmer || '').trim();
      // Definitive output sanitization: never ship Thai/Lao.
      if (khmer && hasWrongScript(khmer)) {
        const cleaned = sanitizeKhmer(khmer);
        if (cleaned) {
          khmer = cleaned;
        } else {
          khmer = '';
        }
      }
      // A valid Khmer line must contain Khmer script. If the source itself is
      // already Khmer (e.g. sourceLanguage=km), keeping it is correct.
      const sourceIsKhmer = KHMER_SCRIPT.test(segment.text) && !hasWrongScript(segment.text);
      const usable = khmer && isValidKhmer(khmer);
      const finalKhmer = usable ? khmer : sourceIsKhmer ? segment.text : khmer || segment.text;
      // If fallback is still Thai/Lao (source was Thai), sanitize that too
      const finalSanitized =
        hasWrongScript(finalKhmer) ? sanitizeKhmer(finalKhmer) || segment.text : finalKhmer;
      return {
        ...segment,
        khmer: finalSanitized,
        emotion: item?.emotion || 'neutral',
      };
    });

    // Post-flight audit: log if any line still has wrong script (should be zero)
    const auditBad = translatedSegments.filter((s) => s.khmer && hasWrongScript(s.khmer)).length;
    if (auditBad > 0) {
      logger.error(`Post-translation audit: ${auditBad} line(s) still have Thai/Lao script after sanitization!`);
    }

    const answeredBy =
      this.answeredProviders.size > 0
        ? [...this.answeredProviders].join(' + ')
        : `${this.provider} (no block answered)`;

    logger.info(
      `Translated ${translations.size}/${ordered.length} dialogue lines to Cambodian Khmer via ${answeredBy} in ${
        chunks.length
      } block(s), ${concurrency} at a time, ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`
    );

    return { segments: translatedSegments, warnings };
  }

  /**
   * Translate one block with the NLLB service.
   *
   * The only thing the service needs is the list of lines and the source FLORES
   * code; the answer is one Khmer line per id. A line the service skipped is left
   * out of the map, which the caller reports and the final mapping falls back to
   * the source for.
   */
  private async translateChunkWithNllb(
    chunk: DialogueSegment[],
    settings: JobSettings,
    translations: Map<string, { khmer: string; emotion?: string }>,
    addWarning: (message: string) => void,
    blockIndex: number,
    blockCount: number
  ): Promise<void> {
    const srcLang = floresCodeFor(settings.sourceLanguage);

    try {
      const answers = await translateWithConfiguredNllb(
        chunk.map((segment) => ({ id: segment.id, text: segment.text })),
        srcLang
      );
      this.answeredProviders.add('nllb');

      let missing = 0;
      for (const segment of chunk) {
        const khmer = (answers.get(segment.id) || '').trim();
        if (!khmer) {
          missing++;
          continue;
        }
        // NLLB reports no emotion; the final mapping defaults it to 'neutral'.
        translations.set(segment.id, { khmer });
      }

      logger.info(
        `NLLB block ${blockIndex + 1}/${blockCount}: translated ${
          chunk.length - missing
        }/${chunk.length} line(s) (${srcLang} -> khm_Khmr).`
      );

      if (missing > 0) {
        addWarning(
          `បន្ទាត់ចំនួន ${missing} ក្នុងក្រុមទី ${blockIndex + 1} មិនបានបកប្រែទេ ដូច្នេះវារក្សាអក្សរដើម។ (${missing} line(s) in block ${
            blockIndex + 1
          } of ${blockCount} came back untranslated; the original text was kept for them.)`
        );
      }
    } catch (err: any) {
      logger.warn(`NLLB block ${blockIndex + 1}/${blockCount} failed:`, err);
      addWarning(
        `ក្រុមបកប្រែទី ${blockIndex + 1}/${blockCount} បរាជ័យ ដូច្នេះបន្ទាត់ក្នុងក្រុមនោះរក្សាអក្សរដើម។ (NLLB translation block ${
          blockIndex + 1
        }/${blockCount} failed: ${err?.message ?? 'unknown error'})`
      );
    }
  }

  /** Convenience wrapper for callers that only need the translated lines. */
  public async translate(
    segments: DialogueSegment[],
    settings: JobSettings,
    onProgress?: TranslationProgressCallback
  ): Promise<DialogueSegment[]> {
    const outcome = await this.translateDialogue(segments, settings, onProgress);
    return outcome.segments;
  }
}

let translationInstance: KhmerDubTranslationService | null = null;

export function getTranslationService(): KhmerDubTranslationService {
  if (!translationInstance) {
    translationInstance = new KhmerDubTranslationService();
  }
  return translationInstance;
}
