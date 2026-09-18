import { GoogleGenAI, Type } from '@google/genai';
import { DialogueSegment, JobSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { getGeminiApiKey } from '../utils/aiKeys.js';
import { groqChatJson, isGroqConfigured, sleep } from '../utils/groq.js';

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

export function hasWrongScript(text: string): boolean {
  return THAI_OR_LAO_SCRIPT.test(text);
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

export class KhmerDubTranslationService {
  private client: GoogleGenAI | null = null;
  private modelName: string;
  private provider: TranslationProviderName;

  constructor() {
    this.provider = resolveTranslationProvider();
    this.modelName =
      this.provider === 'groq'
        ? process.env.GROQ_TRANSLATION_MODEL || 'openai/gpt-oss-120b'
        : process.env.GEMINI_MODEL || 'gemini-3.8-flash';

    if (this.provider === 'gemini') {
      const apiKey = getGeminiApiKey();
      if (apiKey) {
        this.client = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
      }
    }
  }

  public getProviderName(): TranslationProviderName {
    return this.provider;
  }

  public getModelName(): string {
    return this.modelName;
  }

  public isConfigured(): boolean {
    return this.provider === 'groq' ? isGroqConfigured() : Boolean(getGeminiApiKey());
  }

  /** How many dialogue lines go into a single model request. */
  public getChunkSize(): number {
    const configured = Number(process.env.TRANSLATION_CHUNK_SIZE);
    return Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_CHUNK_SIZE;
  }

  /**
   * Translates dialogue segments into natural spoken Cambodian Khmer.
   *
   * The transcript is sent in blocks rather than one giant request: a single
   * request grows past Groq's 8k tokens/minute ceiling at roughly four minutes
   * of video and then fails with HTTP 429. Blocking also lets the job report
   * real progress and keeps a bad block from discarding the whole transcript.
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
    const translations = new Map<string, { khmer: string; emotion?: string }>();
    const warnings: string[] = [];
    // Rolling window of already-translated lines so names, pronouns and terms
    // stay consistent across block boundaries.
    let recentContext: { speaker: string; original: string; khmer: string }[] = [];
    let completedLines = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let billedTokens = 0;
      const requestStartedAt = Date.now();

      try {
        const userPrompt = this.buildChunkPrompt(chunk, recentContext, i, chunks.length);
        // Fallback estimate in case the provider does not report usage.
        const estimatedTokens = estimateTokens(systemInstruction + userPrompt) + chunk.length * 45;

        const response = await this.requestTranslation(systemInstruction, userPrompt);
        billedTokens = response.totalTokens || estimatedTokens;
        logger.info(
          `Translation block ${i + 1}/${chunks.length}: ${chunk.length} line(s), ${billedTokens} tokens.`
        );
        const parsed = this.parseChunkResponse(response.content);

        let missing = 0;
        const blockContext: typeof recentContext = [];
        for (let lineIndex = 0; lineIndex < chunk.length; lineIndex++) {
          const segment = chunk[lineIndex];
          const item = parsed.get(segment.id) || parsed.get(`__index_${lineIndex}`);
          const khmer = (item?.khmer || '').trim();
          if (!khmer) missing++;
          if (khmer) {
            translations.set(segment.id, { khmer, emotion: item?.emotion });
            blockContext.push({
              speaker: segment.speaker,
              original: segment.text,
              khmer,
            });
          }
        }

        await this.repairWrongScriptLines(chunk, translations, systemInstruction, warnings);

        if (missing > 0) {
          warnings.push(
            `បន្ទាត់ចំនួន ${missing} ក្នុងក្រុមទី ${i + 1} មិនបានបកប្រែទេ ដូច្នេះវារក្សាអក្សរដើម។ (${missing} line(s) in block ${
              i + 1
            } of ${chunks.length} came back untranslated; the original text was kept for them.)`
          );
        }

        recentContext = [...recentContext, ...blockContext].slice(-8);
      } catch (chunkErr: any) {
        // One bad block should not throw away a good transcription.
        logger.warn(`Translation block ${i + 1}/${chunks.length} failed:`, chunkErr);
        warnings.push(
          `ក្រុមបកប្រែទី ${i + 1}/${chunks.length} បរាជ័យ ដូច្នេះបន្ទាត់ក្នុងក្រុមនោះរក្សាអក្សរដើម។ (Translation block ${
            i + 1
          }/${chunks.length} failed: ${chunkErr?.message ?? 'unknown error'})`
        );
      }

      completedLines += chunk.length;
      if (onProgress) await onProgress(completedLines, segments.length);

      // Pace the next request against the per-minute token ceiling. There is
      // nothing left to protect after the final block, so don't wait for it.
      if (i < chunks.length - 1) {
        await this.paceRequest(billedTokens, requestStartedAt);
      }
    }

    const translatedSegments = segments.map((segment) => {
      const item = translations.get(segment.id);
      // Keep the source line when a block failed or the answer used the wrong script.
      const usable = item?.khmer && !hasWrongScript(item.khmer);
      return {
        ...segment,
        khmer: usable ? item!.khmer : segment.text,
        emotion: item?.emotion || 'neutral',
      };
    });

    logger.info(
      `Translated ${translations.size}/${segments.length} dialogue lines to Cambodian Khmer via ${
        this.provider
      } in ${chunks.length} block(s).`
    );

    return { segments: translatedSegments, warnings };
  }

  private buildSystemInstruction(settings: JobSettings): string {
    const isFormal = settings.translationStyle === 'formal';
    const voiceStyle = settings.voiceStyle || 'natural';

    return `You are a professional Cambodian Khmer dubbing director and translator for movies and videos.
Your mission is to translate spoken English/original dialogue into natural, authentic spoken Cambodian Khmer (ភាសាខ្មែរនិយាយបែបធម្មជាតិ).

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
11. You will receive the transcript in numbered blocks. Translate EVERY line in the block you are given and echo back its exact "id" — never merge, split, reorder or skip lines.`;
  }

  private buildChunkPrompt(
    chunk: DialogueSegment[],
    recentContext: { speaker: string; original: string; khmer: string }[],
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
      recentContext.length > 0
        ? `\nAlready translated lines from the previous block (keep names, pronouns and terminology consistent with these):\n${JSON.stringify(
            recentContext,
            null,
            2
          )}\n`
        : '';

    return `Block ${chunkIndex + 1} of ${chunkCount} from the video's dialogue sequence. Translate ONLY the lines listed below.
${contextSection}
Lines to translate:
${JSON.stringify(formattedInput, null, 2)}

Return JSON containing exactly ${
      chunk.length
    } entries, in the same order, each with the line's original "id", its natural spoken Khmer "khmer" translation, and the detected "emotion".`;
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

    const content = await withRetry(
      async () => {
        const response = await this.client!.models.generateContent({
          model: this.modelName,
          contents: userPrompt,
          config: {
            systemInstruction,
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseSchema: {
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
            },
          },
        });

        return response.text?.trim() || '';
      },
      { operationName: 'Gemini Khmer dubbing translation', maxAttempts: 2 }
    );

    return {
      content,
      totalTokens: estimateTokens(systemInstruction + userPrompt) + 400,
    };
  }

  /**
   * Normalise whatever the model returned into an id -> translation map.
   * Models sometimes answer with a bare array, or with a single segment object
   * when the block only has one line, so all three shapes are accepted.
   */
  private parseChunkResponse(rawText: string): Map<string, { khmer: string; emotion?: string }> {
    const items = this.extractTranslatedItems(JSON.parse(rawText));
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
   * Thai and Lao share visual shapes with Khmer, so the model occasionally slips
   * a Thai word into an otherwise Khmer line (e.g. "ไปไหน" instead of "ទៅណា").
   * Ask once for a pure-Khmer rewrite of just the affected lines, and remember
   * which ones are repaired so unrepaired lines can fall back to the source text.
   */
  private async repairWrongScriptLines(
    chunk: DialogueSegment[],
    translations: Map<string, { khmer: string; emotion?: string }>,
    systemInstruction: string,
    warnings: string[]
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

    const repairPrompt = `The Khmer lines below were returned with Thai or Lao script characters mixed in. Rewrite them in pure Khmer Unicode (U+1780-U+17FF) only — no Thai, no Lao, no other script.

Lines to fix:
${JSON.stringify(lines, null, 2)}

Return JSON with exactly one entry per id, each holding the corrected pure-Khmer "khmer" text and its "emotion". Keep each meaning and approximate length unchanged.`;

    try {
      const repaired = await this.requestTranslation(systemInstruction, repairPrompt);
      const parsed = this.parseChunkResponse(repaired.content);

      let stillBad = 0;
      suspects.forEach((segment, index) => {
        const candidate = (
          parsed.get(segment.id)?.khmer ||
          parsed.get(`__index_${index}`)?.khmer ||
          ''
        ).trim();

        if (candidate && !hasWrongScript(candidate)) {
          translations.set(segment.id, {
            khmer: candidate,
            emotion: translations.get(segment.id)?.emotion,
          });
        } else {
          stillBad++;
        }
      });

      if (stillBad > 0) {
        warnings.push(
          `បន្ទាត់ចំនួន ${stillBad} នៅមានអក្សរថៃលាយឡំ ដូច្នេះវារក្សាអក្សរដើម។ (${stillBad} line(s) still contained non-Khmer script after a rewrite attempt; the original text was kept for them.)`
        );
      }
    } catch (repairErr: any) {
      logger.warn('Pure-Khmer rewrite attempt failed:', repairErr);
      warnings.push(
        `ការកែអក្សរថៃលាយឡំមិនបានសម្រេចទេ។ (Could not repair lines that came back in Thai script: ${
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
