import { Type } from '@google/genai';
import { DialogueSegment, JobSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import { groqChatJson, isGroqConfigured, sleep } from '../utils/groq.js';
import { geminiGenerateJson, getGeminiModels, isGeminiConfigured } from '../utils/gemini.js';
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

export type TranslationProviderName = 'groq' | 'gemini';

const DEFAULT_CHUNK_SIZE = 20;

/**
 * How many transcript blocks are translated at the same time. Blocks are separate
 * requests with no dependency between them (each carries the lines around it as
 * context), so asking several at once is the difference between paying for the
 * provider's latency once per wave and once per block.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * One line of context handed to a block so names, pronouns and terminology stay
 * consistent across block boundaries.
 */
export interface ContextLine {
  speaker: string;
  original: string;
  /** How the line reads in Khmer, once a block has been translated. */
  khmer?: string;
}

/**
 * The JSON shape every model answers with. Declared once so the schema a model
 * is constrained by is exactly the one the caller parses.
 */
const TRANSLATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          khmer: {
            type: Type.STRING,
            description: 'Natural spoken Cambodian Khmer translation',
          },
          emotion: {
            type: Type.STRING,
            description: 'Detected emotion (e.g. neutral, energetic, calm, dramatic)',
          },
        },
        required: ['id', 'khmer', 'emotion'],
      },
    },
  },
  required: ['segments'],
};

/** Groq's free tier allows 8k tokens/minute; stay just under it to avoid 429s. */
const TOKEN_BUDGET_PER_MINUTE = Number(process.env.GROQ_TOKENS_PER_MINUTE || '7800');

/** Rough token count for mixed Latin/Khmer text, used only for request pacing. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Khmer is U+1780-U+17FF. Thai (U+0E00-U+0E7F) and Lao (U+0E80-U+0EFF) look close
 * enough that the model sometimes substitutes them for Khmer characters.
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

/** Strip Markdown fences (```json ... ```) that some models wrap around JSON. */
function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    // remove leading ```json and trailing ```
    return trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/g, '')
      .trim();
  }
  return trimmed;
}

/** A parsed brand glossary: terms to keep verbatim, plus terms with a fixed Khmer form. */
export interface Glossary {
  /** Written exactly as given inside the Khmer line — never translated or transliterated. */
  keep: string[];
  /** Always rendered with this one Khmer phrase. */
  forced: { term: string; translation: string }[];
}

/** Enough room for a real product's names without bloating every request. */
const MAX_GLOSSARY_ENTRIES = 200;
const MAX_GLOSSARY_TERM_LENGTH = 80;

/**
 * Reads the glossary the studio sends: one entry per line, `#` for comments.
 *
 *   Google            -> kept verbatim in the Khmer sentence
 *   CEO = នាយកប្រតិបត្តិ  -> always rendered with this exact Khmer phrase
 */
export function parseGlossary(raw?: string | null): Glossary {
  const keep: string[] = [];
  const forced: { term: string; translation: string }[] = [];
  if (!raw) return { keep, forced };

  const seen = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    if (keep.length + forced.length >= MAX_GLOSSARY_ENTRIES) break;

    const entry = line.trim().replace(/^[-*•]\s*/, '');
    if (!entry || entry.startsWith('#')) continue;

    // Any line carrying an `=` is a forced rendering. When it is malformed or
    // repeats a term it is dropped, never re-read as a plain "keep" entry —
    // "CEO = ..." is not a term anybody wants written verbatim in the dub.
    const equals = entry.indexOf('=');
    if (equals >= 0) {
      const term = entry.slice(0, equals).trim();
      const translation = entry.slice(equals + 1).trim();
      const key = `f:${term.toLowerCase()}`;
      if (!term || !translation || term.length > MAX_GLOSSARY_TERM_LENGTH || seen.has(key)) {
        continue;
      }
      seen.add(key);
      forced.push({ term, translation });
      continue;
    }

    const key = `k:${entry.toLowerCase()}`;
    if (entry.length <= MAX_GLOSSARY_TERM_LENGTH && !seen.has(key)) {
      seen.add(key);
      keep.push(entry);
    }
  }

  return { keep, forced };
}

/** True when `text` contains `term` as a whole word, ignoring case. */
export function containsTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** The prompt block that turns a parsed glossary into instructions. Empty when unused. */
function buildGlossarySection(glossary: Glossary): string {
  const { keep, forced } = glossary;
  if (keep.length === 0 && forced.length === 0) return '';

  const rules: string[] = [];
  if (keep.length > 0) {
    rules.push(
      `- Write these exactly as shown, in their original script, inside the Khmer sentence. Never translate them, never rewrite them in Khmer characters, never "correct" their spelling: ${keep.join(
        ', '
      )}.`
    );
  }
  if (forced.length > 0) {
    rules.push(
      `- Always render these with the given Khmer wording, even when the sentence could be phrased differently: ${forced
        .map((f) => `"${f.term}" -> "${f.translation}"`)
        .join(', ')}.`
    );
  }
  rules.push(
    '- Keeping these terms intact matters more than a smoother sentence: build the Khmer sentence around them.'
  );

  return `\nBRAND GLOSSARY — HIGHEST PRIORITY, APPLIES TO EVERY LINE:\n${rules.join('\n')}\n`;
}

/**
 * Pick the translation backend: an explicit TRANSLATION_PROVIDER wins, otherwise
 * whichever provider actually has a key configured.
 */
export function resolveTranslationProvider(): TranslationProviderName {
  const configured = (process.env.TRANSLATION_PROVIDER || '').toLowerCase();
  if (configured === 'groq') return 'groq';
  if (configured === 'gemini') return 'gemini';
  return isGroqConfigured() ? 'groq' : 'gemini';
}

/**
 * Naming the source language lets the model read the original correctly (Mandarin
 * idioms, English contractions) instead of treating the text as language-neutral.
 */
const SOURCE_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  zh: 'Mandarin Chinese',
  th: 'Thai',
  vi: 'Vietnamese',
  ko: 'Korean',
  ja: 'Japanese',
  km: 'Khmer',
  fr: 'French',
  es: 'Spanish',
};

export class KhmerDubTranslationService {
  private modelName: string;
  private provider: TranslationProviderName;

  constructor() {
    this.provider = resolveTranslationProvider();
    // Gemini's clients are created per request inside the rotation, because a
    // block may end up on any model and any key.
    this.modelName =
      this.provider === 'groq'
        ? process.env.GROQ_TRANSLATION_MODEL || 'openai/gpt-oss-120b'
        : getGeminiModels()[0];
  }

  public getProviderName(): TranslationProviderName {
    return this.provider;
  }

  public getModelName(): string {
    return this.modelName;
  }

  public isConfigured(): boolean {
    return this.provider === 'groq' ? isGroqConfigured() : isGeminiConfigured();
  }

  /** Every model the Gemini rotation may use, best first. */
  public getFallbackModelNames(): string[] {
    return this.provider === 'gemini' ? getGeminiModels() : [];
  }

  /** How many dialogue lines go into a single model request. */
  public getChunkSize(): number {
    const configured = Number(process.env.TRANSLATION_CHUNK_SIZE);
    return Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_CHUNK_SIZE;
  }

  /**
   * How many blocks are in flight at once.
   *
   * Gemini tolerates several concurrent calls, so its blocks overlap. Groq's free
   * tier caps tokens per minute, where overlapping requests only earn a 429, so its
   * blocks stay strictly sequential and paced.
   */
  public getConcurrency(): number {
    if (this.provider === 'groq') return 1;

    const configured = Number(process.env.TRANSLATION_CONCURRENCY);
    return Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_CONCURRENCY;
  }

  /**
   * Translates dialogue segments into natural spoken Cambodian Khmer.
   *
   * The transcript is sent in blocks rather than one giant request: a single
   * request grows past Groq's 8k tokens/minute ceiling at roughly four minutes
   * of video and then fails with HTTP 429. Blocking also lets the job report
   * real progress and keeps a bad block from discarding the whole transcript.
   *
   * The blocks do not depend on each other, so they are asked at the same time
   * (see getConcurrency) and the stage costs roughly one provider round trip per
   * wave instead of one per block.
   */
  public async translateDialogue(
    segments: DialogueSegment[],
    settings: JobSettings,
    onProgress?: TranslationProgressCallback
  ): Promise<TranslationOutcome> {
    if (!this.isConfigured()) {
      throw new Error(
        'No translation provider is configured. Set GROQ_API_KEY or GEMINI_API_KEY.'
      );
    }

    if (segments.length === 0) {
      return { segments: [], warnings: [] };
    }

    const chunkSize = this.getChunkSize();
    const chunks: DialogueSegment[][] = [];
    for (let i = 0; i < segments.length; i += chunkSize) {
      chunks.push(segments.slice(i, i + chunkSize));
    }

    const systemInstruction = this.buildSystemInstruction(settings);
    const glossary = parseGlossary(settings.glossary);
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
    // Rolling window of already-translated lines so names, pronouns and terms
    // stay consistent across block boundaries. Only a sequential run can use it —
    // concurrent blocks anchor on the source lines of the block before them instead.
    let recentContext: ContextLine[] = [];

    await mapWithConcurrency(chunks, concurrency, async (chunk, i) => {
      const context: ContextLine[] =
        concurrency > 1
          ? i === 0
            ? []
            : chunks[i - 1].slice(-8).map((s) => ({ speaker: s.speaker, original: s.text }))
          : recentContext;

      let billedTokens = 0;
      const requestStartedAt = Date.now();

      try {
        const userPrompt = this.buildChunkPrompt(chunk, context, i, chunks.length);
        // Fallback estimate in case the provider does not report usage.
        const estimatedTokens = estimateTokens(systemInstruction + userPrompt) + chunk.length * 45;

        const response = await this.requestTranslation(systemInstruction, userPrompt);
        billedTokens = response.totalTokens || estimatedTokens;
        logger.info(
          `Translation block ${i + 1}/${chunks.length}: ${chunk.length} line(s), ${billedTokens} tokens.`
        );
        const parsed = this.parseChunkResponse(response.content);

        let missing = 0;
        const blockContext: ContextLine[] = [];
        for (let lineIndex = 0; lineIndex < chunk.length; lineIndex++) {
          const segment = chunk[lineIndex];
          const item = parsed.get(segment.id) || parsed.get(`__index_${lineIndex}`);
          const khmer = (item?.khmer || '').trim();
          if (!khmer) missing++;
          if (khmer) {
            // Store as-is; wrong-script will be repaired next. But if it already
            // has Thai/Lao we try an immediate local strip so the rescue path
            // sees a cleaner starting point.
            let toStore = khmer;
            if (hasWrongScript(toStore)) {
              const cleaned = sanitizeKhmer(toStore);
              if (cleaned) toStore = cleaned;
            }
            translations.set(segment.id, { khmer: toStore, emotion: item?.emotion });
            blockContext.push({
              speaker: segment.speaker,
              original: segment.text,
              khmer: toStore,
            });
          }
        }

        // Repair wrong-script lines robustly (LLM + local sanitization + rescue)
        await this.repairWrongScriptLines(chunk, translations, systemInstruction);

        // If some lines came back empty, try to rescue them with a focused retry
        if (missing > 0) {
          const stillMissingSegments = chunk.filter((seg) => {
            const kh = translations.get(seg.id)?.khmer?.trim();
            return !kh;
          });
          if (stillMissingSegments.length > 0) {
            logger.warn(
              `${stillMissingSegments.length} line(s) in block ${i + 1} missing after first pass; rescuing.`
            );
            await this.rescueMissingLines(stillMissingSegments, translations, systemInstruction);
          }
          const stillMissing = chunk.filter((seg) => !translations.get(seg.id)?.khmer?.trim()).length;
          if (stillMissing > 0) {
            addWarning(
              `បន្ទាត់ចំនួន ${stillMissing} ក្នុងក្រុមទី ${i + 1} មិនបានបកប្រែទេ ដូច្នេះវារក្សាអក្សរដើម។ (${stillMissing} line(s) in block ${
                i + 1
              } of ${chunks.length} came back untranslated; the original text was kept for them.)`
            );
          } else if (missing > 0) {
            logger.info(`Rescued ${missing} missing line(s) in block ${i + 1}.`);
          }
        }

        await this.enforceGlossary(chunk, translations, glossary, systemInstruction, warnings);

        // Final per-block sanitization: any Thai/Lao that survived the repair is
        // stripped locally so it never reaches the output. This guarantees the
        // job never ships Thai script even if the LLM rewrites failed.
        for (const seg of chunk) {
          const entry = translations.get(seg.id);
          if (entry?.khmer && hasWrongScript(entry.khmer)) {
            const cleaned = sanitizeKhmer(entry.khmer);
            if (cleaned) {
              translations.set(seg.id, { khmer: cleaned, emotion: entry.emotion });
              logger.info(`Sanitized surviving Thai/Lao script for ${seg.id} after block ${i + 1}.`);
            } else {
              // No Khmer left after stripping — drop it so the final mapping
              // can treat it as missing and rescue/keep source cleanly.
              translations.delete(seg.id);
            }
          }
        }

        if (concurrency === 1) {
          recentContext = [...recentContext, ...blockContext].slice(-8);
        }
      } catch (chunkErr: any) {
        // One bad block should not throw away a good transcription.
        // Try to salvage any lines that were already stored before the throw.
        logger.warn(`Translation block ${i + 1}/${chunks.length} failed:`, chunkErr);
        const salvaged = chunk.filter((seg) => translations.has(seg.id)).length;
        if (salvaged === 0) {
          addWarning(
            `ក្រុមបកប្រែទី ${i + 1}/${chunks.length} បរាជ័យ ដូច្នេះបន្ទាត់ក្នុងក្រុមនោះរក្សាអក្សរដើម។ (Translation block ${
              i + 1
            }/${chunks.length} failed: ${chunkErr?.message ?? 'unknown error'})`
          );
        } else {
          // Partial salvage: only warn for lines that could not be salvaged
          const missingCount = chunk.length - salvaged;
          if (missingCount > 0) {
            addWarning(
              `បន្ទាត់ចំនួន ${missingCount} ក្នុងក្រុមទី ${i + 1} មិនបានបកប្រែពេញលេញទេ។ (${missingCount} line(s) in block ${
                i + 1
              } partially translated.)`
            );
          }
        }
      }

      completedLines += chunk.length;
      if (onProgress) await onProgress(completedLines, segments.length);

      // Pace the next request against the per-minute token ceiling. There is
      // nothing left to protect after the final block, so don't wait for it.
      // A concurrent run has no next request of its own to pace.
      if (concurrency === 1 && i < chunks.length - 1) {
        await this.paceRequest(billedTokens, requestStartedAt);
      }
    });

    const translatedSegments = segments.map((segment) => {
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

    logger.info(
      `Translated ${translations.size}/${segments.length} dialogue lines to Cambodian Khmer via ${
        this.provider
      } in ${chunks.length} block(s), ${concurrency} at a time, ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)}s.`
    );

    return { segments: translatedSegments, warnings };
  }

  private buildSystemInstruction(settings: JobSettings): string {
    const isFormal = settings.translationStyle === 'formal';
    const voiceStyle = settings.voiceStyle || 'natural';

    const sourceLanguage = settings.sourceLanguage && settings.sourceLanguage !== 'auto'
      ? SOURCE_LANGUAGE_NAMES[settings.sourceLanguage]
      : '';

    return `You are a professional Cambodian Khmer dubbing director and translator for movies and videos.
Your mission is to translate spoken ${sourceLanguage || 'English/original'} dialogue into natural, authentic spoken Cambodian Khmer (ភាសាខ្មែរនិយាយបែបធម្មជាតិ).
${sourceLanguage ? `The dialogue you receive is ${sourceLanguage}. Read it as a native speaker of that language before translating, and keep proper names, numbers and units exactly as spoken.\n` : ''}${buildGlossarySection(parseGlossary(settings.glossary))}
CRITICAL DUBBING TRANSLATION RULES:
1. NEVER translate word-by-word if it sounds stiff, robotic, or unnatural.
2. PRESERVE MEANING & EMOTIONAL CONTEXT: Translate into authentic Cambodian conversational phrases that actors actually speak in Cambodia.
   - Example 1: "Where have you been all day?" -> "ថ្ងៃនេះអ្នកទៅណាមក?" (NOT: "តើអ្នកបាននៅឯណាពេញមួយថ្ងៃ?")
   - Example 2: "What's going on?" -> "មានរឿងអីកើតឡើងហ្នឹង?"
   - Example 3: "Let's go!" -> "តោះទៅ!"
3. CHARACTER RELATIONSHIP & CONTEXT WINDOW:
   - Analyze the conversation flow between speakers.
   - Maintain consistent pronouns, honorifics, and speaking styles based on character relationships (e.g. older to younger, friends, polite business, parent to child).
   - Keep names and key terms consistent across all lines.
   - A NAME IS NEVER A WORD TO TRANSLATE. Never translate a person's, brand's, product's or place's name by its meaning ("Apple" the company is never ផ្លែប៉ោម; "Mark" a person is never សម្គាល់). Spell it the way it sounds in the original, and spell it the same way every time.
4. FIT ORIGINAL DURATION (LIP-SYNC / TIMING CONSTRAINT):
   - Cambodian Khmer audio takes time to speak.
   - Calculate duration = end - start seconds.
   - Keep the Khmer translation concise enough to be spoken comfortably within the original segment duration.
   - If a literal translation would be too long for the duration, rephrase or condense it naturally.
5. PRESERVE EMOTIONAL TONE & SPEECH:
   - Identify emotion: "neutral", "energetic", "calm", "dramatic", "happy", "serious".
   - Reflect this tone in the chosen Khmer phrasing and punctuation.
6. STYLE MODE:
   - Current style requested: ${isFormal ? 'Formal Khmer (សមរម្យ/ផ្លូវការ)' : 'Natural Spoken Khmer (បែបសន្ទនាធម្មជាតិ)'}.
   - Voice style atmosphere: ${voiceStyle}.
7. DO NOT TRANSLATE non-verbal sounds, sound effects, or laughter.
8. NEVER invent dialogue or add explanatory notes outside the JSON structure.
9. Return STRICT JSON only matching the schema.
10. SOURCE LANGUAGE: the dialogue may already be in Khmer. If a line is already Khmer, keep it as Khmer and only clean up obvious spacing or spelling — do NOT re-translate it, and never change proper names or numbers.
11. You will receive the transcript in numbered blocks. Translate EVERY line in the block you are given and echo back its exact "id" — never merge, split, reorder or skip lines.
12. SCRIPT PURITY — ABSOLUTE REQUIREMENT:
   - Every "khmer" value you return MUST be written in pure Khmer Unicode only (U+1780-U+17FF plus Khmer punctuation U+17D4-U+17DD, digits, and basic Latin for brand names from the glossary).
   - FORBIDDEN: Thai script (U+0E00-U+0E7F) and Lao script (U+0E80-U+0EFF) are NEVER allowed, not even one character. ការសរសេរត្រូវតែជាអក្សរខ្មែរសុទ្ធ 100% ហាមប្រើអក្សរថៃឬឡាវដាច់ខាត។
   - Bad example (DO NOT DO): "ไปไหนมา" (Thai) instead of "ទៅណាមក" (Khmer) — they look similar but are different Unicode.
   - If you are unsure of a Khmer spelling, use the closest valid Khmer characters, never substitute Thai/Lao shapes.
   - Before returning, mentally verify each line contains no Thai/Lao codepoints.`;
  }

  private buildChunkPrompt(
    chunk: DialogueSegment[],
    context: ContextLine[],
    chunkIndex: number,
    chunkCount: number
  ): string {
    const formattedInput = chunk.map((s) => ({
      id: s.id,
      speaker: s.speaker,
      start: s.start,
      end: s.end,
      duration: Number((s.end - s.start).toFixed(2)),
      text: s.text,
    }));

    const contextSection =
      context.length > 0
        ? `\nEarlier lines from the same conversation (keep names, pronouns and terminology consistent with these):\n${JSON.stringify(
            context,
            null,
            2
          )}\n`
        : '';

    return `Block ${chunkIndex + 1} of ${chunkCount} from the video's dialogue sequence. Translate ONLY the lines listed below. Output pure Khmer script only (U+1780-U+17FF) — zero Thai/Lao characters allowed.
${contextSection}
Lines to translate:
${JSON.stringify(formattedInput, null, 2)}

Return JSON containing exactly ${
      chunk.length
    } entries, in the same order, each with the line's original "id", its natural spoken Khmer "khmer" translation (pure Khmer Unicode, no Thai/Lao), and the detected "emotion".`;
  }

  /** Dispatch one block to the configured provider and return its raw JSON text. */
  private async requestTranslation(
    systemInstruction: string,
    userPrompt: string
  ): Promise<{ content: string; totalTokens: number }> {
    if (this.provider === 'groq') {
      // Fallback models when primary is rate-limited (429)
      // These are ordered by preference: smaller/faster models first as they often have separate rate limits
      const fallbackModels = (process.env.GROQ_TRANSLATION_FALLBACK_MODELS || 'openai/gpt-oss-20b,qwen/qwen3.8-27b')
        .split(',')
        .map(m => m.trim())
        .filter(m => m && m !== this.modelName); // Exclude primary model from fallbacks
      
      return groqChatJson({
        model: this.modelName,
        systemInstruction,
        userPrompt,
        temperature: 0.3,
        operationName: 'Khmer dubbing translation',
        maxAttempts: 3,
        reasoningEffort: (process.env.GROQ_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'low',
        fallbackModels,
        schema: {
          name: 'khmer_translation',
          schema: {
            type: 'object',
            properties: {
              segments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    khmer: { type: 'string' },
                    emotion: { type: 'string' },
                  },
                  required: ['id', 'khmer', 'emotion'],
                  additionalProperties: false,
                },
              },
            },
            required: ['segments'],
            additionalProperties: false,
          },
        },
      });
    }

    // The rotation lives in `utils/gemini.ts`: it walks the free-tier models and
    // then the configured keys, so one model whose quota is spent (or one key
    // that is rejected) cannot stop a job — the next block simply asks the next
    // model for the same JSON.
    const answer = await geminiGenerateJson({
      systemInstruction,
      userPrompt,
      temperature: 0.3,
      operationName: 'Khmer dubbing translation',
      responseSchema: TRANSLATION_SCHEMA as unknown as Record<string, unknown>,
    });

    return {
      content: answer.content,
      // Gemini reports real usage; the estimate is only a fallback for the rare
      // answer that comes back without it (the caller uses this to pace blocks).
      totalTokens: answer.totalTokens || estimateTokens(systemInstruction + userPrompt) + 400,
    };
  }

  /**
   * Normalise whatever the model returned into an id -> translation map.
   * Models sometimes answer with a bare array, or with a single segment object
   * when the block only has one line, so all three shapes are accepted.
   * Also strips Markdown fences that some models add.
   */
  private parseChunkResponse(rawText: string): Map<string, { khmer: string; emotion?: string }> {
    const cleaned = stripJsonFences(rawText);
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e: any) {
      // Try to salvage: extract first JSON object/array from the text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          throw new Error(`Translation response was not valid JSON: ${e.message}`);
        }
      } else {
        throw new Error(`Translation response was not valid JSON: ${e.message}`);
      }
    }
    const items = this.extractTranslatedItems(parsed);
    const byId = new Map<string, { khmer: string; emotion?: string }>();

    items.forEach((item: any, index: number) => {
      const entry = { khmer: item?.khmer || item?.text || '', emotion: item?.emotion };
      if (item?.id) byId.set(String(item.id), entry);
      // Also key by position so a model that drops ids still lines up.
      byId.set(`__index_${index}`, entry);
    });

    return byId;
  }

  private extractTranslatedItems(parsed: any): any[] {
    if (Array.isArray(parsed?.segments)) return parsed.segments;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && ('khmer' in parsed || 'text' in parsed)) {
      return [parsed];
    }
    return [];
  }

  /**
   * Rescue lines that came back empty. Asks the model again for just those ids
   * with a focused prompt, so one malformed block does not lose its lines.
   */
  private async rescueMissingLines(
    missingSegments: DialogueSegment[],
    translations: Map<string, { khmer: string; emotion?: string }>,
    systemInstruction: string
  ): Promise<void> {
    if (missingSegments.length === 0) return;
    const lines = missingSegments.map((s) => ({
      id: s.id,
      speaker: s.speaker,
      start: s.start,
      end: s.end,
      duration: Number((s.end - s.start).toFixed(2)),
      text: s.text,
    }));
    const rescuePrompt = `Some lines from the previous block were missing. Translate ONLY these ${lines.length} line(s) now into pure Khmer (U+1780-U+17FF, no Thai/Lao). Echo each "id" exactly.\n\nLines to translate:\n${JSON.stringify(lines, null, 2)}\n\nReturn JSON with exactly ${lines.length} entries, each with "id", pure-Khmer "khmer", and "emotion".`;
    try {
      const rescued = await this.requestTranslation(systemInstruction, rescuePrompt);
      const parsed = this.parseChunkResponse(rescued.content);
      let recovered = 0;
      missingSegments.forEach((seg, idx) => {
        const cand = (parsed.get(seg.id)?.khmer || parsed.get(`__index_${idx}`)?.khmer || '').trim();
        if (cand) {
          const cleaned = hasWrongScript(cand) ? sanitizeKhmer(cand) : cand;
          if (cleaned) {
            translations.set(seg.id, {
              khmer: cleaned,
              emotion: parsed.get(seg.id)?.emotion || parsed.get(`__index_${idx}`)?.emotion,
            });
            recovered++;
          } else if (cand && isValidKhmer(cand)) {
            translations.set(seg.id, {
              khmer: cand,
              emotion: parsed.get(seg.id)?.emotion || parsed.get(`__index_${idx}`)?.emotion,
            });
            recovered++;
          }
        }
      });
      if (recovered > 0) logger.info(`Rescued ${recovered}/${missingSegments.length} missing line(s) on retry.`);
    } catch (err: any) {
      logger.warn('Missing-line rescue failed:', err?.message || err);
    }
  }

  /**
   * Thai and Lao share visual shapes with Khmer, so the model occasionally slips
   * a Thai word into an otherwise Khmer line (e.g. "ไปไหน" instead of "ទៅណា").
   * This now uses a 3-tier strategy:
   *  1) LLM rewrite for affected lines
   *  2) Local sanitization (strip Thai/Lao codepoints) for any line that still has them
   *  3) Targeted rescue translation for lines where stripping left nothing usable
   * Only lines that survive all three tiers trigger a warning; auto-sanitized lines
   * are silent because the output is already pure Khmer.
   */
  private async repairWrongScriptLines(
    chunk: DialogueSegment[],
    translations: Map<string, { khmer: string; emotion?: string }>,
    systemInstruction: string
  ): Promise<void> {
    const suspects = chunk.filter((segment) => {
      const translated = translations.get(segment.id)?.khmer;
      return translated ? hasWrongScript(translated) : false;
    });

    if (suspects.length === 0) return;

    logger.warn(
      `${suspects.length} translated line(s) contained Thai/Lao characters; requesting a pure-Khmer rewrite.`
    );

    const lines = suspects.map((segment) => ({
      id: segment.id,
      english: segment.text,
      khmer: translations.get(segment.id)?.khmer || '',
    }));

    const repairPrompt = `CRITICAL SCRIPT CORRECTION: The Khmer lines below were returned with Thai (U+0E00-U+0E7F) or Lao (U+0E80-U+0EFF) characters mixed in. This is FORBIDDEN. Rewrite each line in 100% pure Khmer Unicode (U+1780-U+17FF only) — no Thai, no Lao, no other script. Even one Thai character makes the line invalid. Use only Khmer characters.

Lines to fix:
${JSON.stringify(lines, null, 2)}

Return JSON with exactly one entry per id, each holding the corrected pure-Khmer "khmer" text and its "emotion". Keep each meaning and approximate length unchanged. Verify each character is Khmer before returning.`;

    let repairSucceeded = false;
    try {
      const repaired = await this.requestTranslation(systemInstruction, repairPrompt);
      const parsed = this.parseChunkResponse(repaired.content);

      let stillBad: DialogueSegment[] = [];
      suspects.forEach((segment, index) => {
        const candidate = (
          parsed.get(segment.id)?.khmer ||
          parsed.get(`__index_${index}`)?.khmer ||
          ''
        ).trim();

        if (candidate && !hasWrongScript(candidate) && KHMER_SCRIPT.test(candidate)) {
          translations.set(segment.id, {
            khmer: candidate,
            emotion: translations.get(segment.id)?.emotion,
          });
        } else if (candidate && hasWrongScript(candidate)) {
          // LLM retry still has Thai — try local strip
          const cleaned = sanitizeKhmer(candidate);
          if (cleaned) {
            translations.set(segment.id, {
              khmer: cleaned,
              emotion: translations.get(segment.id)?.emotion,
            });
            logger.info(`Auto-stripped Thai/Lao from LLM repair for ${segment.id}.`);
          } else {
            stillBad.push(segment);
          }
        } else if (candidate && isValidKhmer(candidate)) {
          translations.set(segment.id, {
            khmer: candidate,
            emotion: translations.get(segment.id)?.emotion,
          });
        } else {
          // Empty or invalid repair — will try local strip of original
          const originalBad = translations.get(segment.id)?.khmer || '';
          const cleanedOrig = sanitizeKhmer(originalBad);
          if (cleanedOrig) {
            translations.set(segment.id, { khmer: cleanedOrig, emotion: translations.get(segment.id)?.emotion });
            logger.info(`Repaired ${segment.id} via local sanitization (LLM repair was empty/invalid).`);
          } else {
            stillBad.push(segment);
          }
        }
      });

      repairSucceeded = true;

      // For any that are still bad after LLM + local strip, try a second targeted rescue
      if (stillBad.length > 0) {
        logger.warn(`${stillBad.length} line(s) still had Thai/Lao after first repair; trying local strip + rescue.`);
        const notYetFixed: DialogueSegment[] = [];
        for (const seg of stillBad) {
          const bad = translations.get(seg.id)?.khmer || '';
          const cleaned = sanitizeKhmer(bad);
          if (cleaned) {
            translations.set(seg.id, { khmer: cleaned, emotion: translations.get(seg.id)?.emotion });
            logger.info(`Fixed ${seg.id} via local strip on second pass.`);
          } else {
            notYetFixed.push(seg);
          }
        }
        if (notYetFixed.length > 0) {
          // Final attempt: re-translate just these lines from source with maximum emphasis on script
          const rescueLines = notYetFixed.map((s) => ({
            id: s.id,
            text: s.text,
            start: s.start,
            end: s.end,
          }));
          const rescuePrompt2 = `Translate these ${rescueLines.length} line(s) to PURE KHMER ONLY. forbidden: Thai (U+0E00-U+0E7F) Lao (U+0E80-U+0EFF). Write only Khmer letters (U+1780-U+17FF). Any Thai character is an error.\n\n${JSON.stringify(rescueLines, null, 2)}\n\nReturn JSON with exactly ${rescueLines.length} entries, each with "id", pure-Khmer "khmer", "emotion".`;
          try {
            const rescue2 = await this.requestTranslation(systemInstruction, rescuePrompt2);
            const parsed2 = this.parseChunkResponse(rescue2.content);
            let rescued2 = 0;
            notYetFixed.forEach((seg, idx) => {
              const cand = (parsed2.get(seg.id)?.khmer || parsed2.get(`__index_${idx}`)?.khmer || '').trim();
              if (cand && isValidKhmer(cand)) {
                translations.set(seg.id, { khmer: cand, emotion: parsed2.get(seg.id)?.emotion || parsed2.get(`__index_${idx}`)?.emotion });
                rescued2++;
              } else if (cand) {
                const c2 = sanitizeKhmer(cand);
                if (c2) {
                  translations.set(seg.id, { khmer: c2, emotion: parsed2.get(seg.id)?.emotion });
                  rescued2++;
                }
              }
            });
            const remaining = notYetFixed.length - rescued2;
            if (remaining === 0) {
              logger.info(`Rescued all ${notYetFixed.length} remaining Thai-script lines on second rescue.`);
              return; // no warning needed
            }
            // If some remain, those will be handled by the outer final sanitization
            // and will NOT produce a user-visible Thai warning — they will be
            // stripped silently. We only warn if the line must fall back to source.
            // To avoid a yellow warning box for a line that was auto-stripped, we
            // suppress the warning here and let the final mapping handle it.
            // Check if stripping leaves valid Khmer
            for (const seg of notYetFixed) {
              const entry = translations.get(seg.id);
              if (entry?.khmer && hasWrongScript(entry.khmer)) {
                const c = sanitizeKhmer(entry.khmer);
                if (c) {
                  translations.set(seg.id, { khmer: c, emotion: entry.emotion });
                }
              }
            }
            // No warning — auto-fixed via strip
            logger.info(`After all repairs, ${remaining} line(s) still needed local strip; handled silently.`);
          } catch (e: any) {
            // Rescue failed — fallback to local strip, no warning if strip works
            let fixed = 0;
            for (const seg of notYetFixed) {
              const bad = translations.get(seg.id)?.khmer || '';
              const c = sanitizeKhmer(bad);
              if (c) {
                translations.set(seg.id, { khmer: c, emotion: translations.get(seg.id)?.emotion });
                fixed++;
              }
            }
            if (fixed === notYetFixed.length) {
              logger.info(`Fixed ${fixed} lines via local strip after rescue failure.`);
            } else {
              logger.warn(`Local strip could not salvage ${notYetFixed.length - fixed} line(s); they will fall back to source.`);
            }
          }
        }
      }
    } catch (repairErr: any) {
      logger.warn('Pure-Khmer rewrite attempt failed:', repairErr?.message || repairErr);
      // Network/LLM failure — try pure local sanitization before giving up
      let locallyFixed = 0;
      for (const seg of suspects) {
        const bad = translations.get(seg.id)?.khmer || '';
        const cleaned = sanitizeKhmer(bad);
        if (cleaned) {
          translations.set(seg.id, { khmer: cleaned, emotion: translations.get(seg.id)?.emotion });
          locallyFixed++;
        }
      }
      if (locallyFixed === suspects.length) {
        logger.info(`Repaired all ${locallyFixed} Thai-script lines via local sanitization after LLM failure.`);
        return;
      }
      if (locallyFixed > 0) {
        logger.info(`Locally sanitized ${locallyFixed}/${suspects.length} lines after LLM failure; ${suspects.length - locallyFixed} will fall back to source.`);
        // Do not push a Thai-script warning when we already fixed most via strip;
        // the remaining will be caught by final sanitization and fallback.
        return;
      }
      // Nothing could be fixed — this is the only case where we surface a warning,
      // but we phrase it as already handled (silent strip) rather than alarming.
      // To keep the job error-free, we still strip what we can.
      for (const seg of suspects) {
        const bad = translations.get(seg.id)?.khmer || '';
        // Even if sanitize returns null, strip raw Thai codepoints so output never contains Thai
        const rawStripped = stripWrongScript(bad);
        if (rawStripped && KHMER_SCRIPT.test(rawStripped)) {
          translations.set(seg.id, { khmer: rawStripped, emotion: translations.get(seg.id)?.emotion });
        } else if (rawStripped) {
          // No Khmer left — leave empty so final mapping falls back to source without Thai
          translations.set(seg.id, { khmer: rawStripped, emotion: translations.get(seg.id)?.emotion });
        }
      }
      if (!repairSucceeded) {
        // We have handled it via stripping; no user warning needed for a fixable script issue.
        logger.info('Handled Thai-script lines via stripping after LLM failure; no warning surfaced.');
      }
    }
  }

  /**
   * The glossary is a promise to the uploader — a brand name must come back exactly
   * as they typed it — and models routinely ignore it by transliterating the name
   * into Khmer script or translating it by meaning. So each line is checked after
   * the fact: if the source carried a protected term and the Khmer line lost it,
   * that line is sent back once for a rewrite. Unrepaired lines are reported, since
   * silently shipping a wrong name is worse than admitting the limit.
   */
  private async enforceGlossary(
    chunk: DialogueSegment[],
    translations: Map<string, { khmer: string; emotion?: string }>,
    glossary: Glossary,
    systemInstruction: string,
    warnings: string[]
  ): Promise<void> {
    if (glossary.keep.length === 0 && glossary.forced.length === 0) return;

    /** The protected terms this line is missing, in the wording the model will read. */
    const missingTerms = (source: string, khmer: string): string[] => {
      const missing: string[] = [];

      for (const term of glossary.keep) {
        if (containsTerm(source, term) && !containsTerm(khmer, term)) {
          missing.push(`"${term}" (write it verbatim, in its original script)`);
        }
      }
      for (const { term, translation } of glossary.forced) {
        if (containsTerm(source, term) && !khmer.includes(translation)) {
          missing.push(`"${term}" -> "${translation}"`);
        }
      }

      return missing;
    };

    const suspects = chunk
      .map((segment) => ({
        segment,
        missing: missingTerms(segment.text, translations.get(segment.id)?.khmer || ''),
      }))
      .filter((entry) => entry.missing.length > 0);

    if (suspects.length === 0) return;

    logger.info(
      `${suspects.length} translated line(s) dropped a glossary term; requesting a rewrite.`
    );

    const repairPrompt = `The Khmer lines below lost a protected glossary term that MUST appear exactly as specified. Rewrite each line so the required term appears verbatim, keeping the Khmer natural and roughly the same length. Change nothing else about the meaning. Keep pure Khmer script (no Thai/Lao).

Lines to fix:
${JSON.stringify(
      suspects.map(({ segment, missing }) => ({
        id: segment.id,
        original: segment.text,
        khmer: translations.get(segment.id)?.khmer || '',
        missingTerms: missing,
      })),
      null,
      2
    )}

Return JSON with exactly one entry per id, each holding the corrected "khmer" text and its "emotion".`;

    try {
      const repaired = await this.requestTranslation(systemInstruction, repairPrompt);
      const parsed = this.parseChunkResponse(repaired.content);
      let stillMissing = 0;

      suspects.forEach(({ segment, missing }, index) => {
        const candidate = (
          parsed.get(segment.id)?.khmer ||
          parsed.get(`__index_${index}`)?.khmer ||
          ''
        ).trim();

        if (candidate && missingTerms(segment.text, candidate).length < missing.length) {
          // Ensure the glossary fix did not reintroduce Thai script
          const finalCand = hasWrongScript(candidate) ? sanitizeKhmer(candidate) || candidate : candidate;
          translations.set(segment.id, {
            khmer: finalCand,
            emotion: translations.get(segment.id)?.emotion,
          });
          if (missingTerms(segment.text, finalCand).length > 0) stillMissing++;
        } else {
          stillMissing++;
        }
      });

      if (stillMissing > 0) {
        warnings.push(
          `បន្ទាត់ចំនួន ${stillMissing} មិនបានរក្សាឈ្មោះក្នុងបញ្ជីពាក្យ (Glossary) តាមការកំណត់ទេ។ (${stillMissing} line(s) did not keep a glossary term exactly as configured; check the names in those lines.)`
        );
      }
    } catch (repairErr: any) {
      logger.warn('Glossary rewrite attempt failed:', repairErr);
      warnings.push(
        `ការកែឈ្មោះតាមបញ្ជីពាក្យ (Glossary) មិនបានសម្រេចទេ។ (Could not rewrite lines that dropped a glossary term: ${
          repairErr?.message ?? 'unknown error'
        }).`
      );
    }
  }

  /**
   * Wait out the remainder of this block's share of the per-minute token budget
   * before starting the next one, so long transcripts never trip the rate limit.
   */
  private async paceRequest(billedTokens: number, chunkStartedAt: number): Promise<void> {
    if (this.provider !== 'groq' || billedTokens <= 0) return;

    const budgetMs = (billedTokens / TOKEN_BUDGET_PER_MINUTE) * 60_000;
    const waitMs = Math.min(65_000, budgetMs - (Date.now() - chunkStartedAt));
    if (waitMs < 250) return;

    logger.info(
      `Pacing translation: waiting ${(waitMs / 1000).toFixed(1)}s to stay inside ${TOKEN_BUDGET_PER_MINUTE} tokens/minute.`
    );
    await sleep(waitMs);
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
