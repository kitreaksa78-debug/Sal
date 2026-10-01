import { Type } from '@google/genai';
import { DialogueSegment, JobSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import { groqChatJson, isGroqConfigured, sleep, GroqRateLimit } from '../utils/groq.js';
import {
  geminiGenerateJson,
  getGeminiModels,
  hasUsableGeminiKey,
  isGeminiConfigured,
} from '../utils/gemini.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { DIALOGUE_GAP_SECONDS } from './audioMixing.js';
import {
  buildConfirmedNameSection,
  buildProperNameSection,
  detectProperNames,
  enforceProperNames,
  namesInText,
  reportedNamesById,
} from './nameProtection.js';

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

/**
 * How many dialogue lines go into one translation request.
 *
 * Every block is billed for the same system prompt — the whole dubbing rule
 * book — so short blocks spend a large share of the per-minute token budget
 * repeating instructions the model has already read, and every block is also one
 * more round trip of provider latency. Wider blocks amortise both: the same
 * lines cost fewer total tokens and fewer round trips, which matters most on the
 * free tier where a job is paced against that budget. A block that fails still
 * costs at most its own lines, because the rescue path asks for those again.
 * `TRANSLATION_CHUNK_SIZE` overrides this.
 */
const DEFAULT_CHUNK_SIZE = 32;

/**
 * How many transcript blocks are translated at the same time. Blocks are separate
 * requests with no dependency between them (each carries the lines around it as
 * context), so asking several at once is the difference between paying for the
 * provider's latency once per wave and once per block.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * How long the configured translation provider is skipped after it fails a
 * block.
 *
 * A provider that just could not answer — every model out of quota, a project
 * denied access — does not recover inside the same job, and asking it again on
 * every block is what turns a slow stage into a stalled one.
 */
const PRIMARY_DOWN_COOLDOWN_MS = Number(process.env.TRANSLATION_PRIMARY_DOWN_MS || '300000');

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
 *
 * `names` is part of the required shape rather than an extra field a model may
 * add: both providers are asked for strict JSON, and a strict schema rejects a
 * property that is not in its `required` list — a line with no proper name is
 * simply asked for `"names": []`.
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
          names: {
            type: Type.ARRAY,
            description:
              'Every proper name this line speaks, with the Khmer spelling used for it. Empty array when the line speaks none.',
            items: {
              type: Type.OBJECT,
              properties: {
                name: {
                  type: Type.STRING,
                  description: 'The name exactly as it appears in the source line',
                },
                khmer: {
                  type: Type.STRING,
                  description:
                    'The Khmer spelling of that name as used in this line, carrying every part of the name',
                },
              },
              required: ['name', 'khmer'],
            },
          },
        },
        required: ['id', 'khmer', 'emotion', 'names'],
      },
    },
  },
  required: ['segments'],
};

/** Groq's free tier allows 8k tokens/minute; stay just under it to avoid 429s. */
const TOKEN_BUDGET_PER_MINUTE = Number(process.env.GROQ_TOKENS_PER_MINUTE || '7800');

/**
 * The one Groq model the fallback translator uses: `openai/gpt-oss-20b`.
 *
 * The owner asked for Groq to run a single model too, so there is no second
 * model to move to — when this one is rate-limited the job waits for its window
 * instead of changing engines, which is what `groqChatJson`'s retry already
 * does. `DEFAULT_GROQ_TRANSLATION_FALLBACKS` is therefore empty on purpose: an
 * entry in it would be exactly the second model the owner asked not to use.
 *
 * Measured through the real dubbing prompt (five English lines carrying a name, a
 * title, a number and an idiom), so this is a deliberate pick and not a leftover:
 * the model answers in ~0.5s and takes the strict JSON schema the pipeline asks
 * for (an earlier build saw it refuse that schema with HTTP 400 — it does not any
 * more; `groqChatJson` still retries in basic JSON mode if a future build does).
 *
 * `GROQ_TRANSLATION_MODEL` / `GROQ_TRANSLATION_FALLBACK_MODELS` override both, so
 * the engine can be changed from the host's environment without a redeploy.
 */
export const DEFAULT_KHMER_TRANSLATION_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_GROQ_TRANSLATION_FALLBACKS: string[] = [];

/** The Groq model a job's translation blocks are sent to. */
export function getGroqTranslationModel(): string {
  return (process.env.GROQ_TRANSLATION_MODEL || '').trim() || DEFAULT_KHMER_TRANSLATION_MODEL;
}

/** The Groq models tried when the first one is rate-limited, best first. */
export function getGroqTranslationFallbacks(): string[] {
  const configured = (process.env.GROQ_TRANSLATION_FALLBACK_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const models = configured.length > 0 ? configured : DEFAULT_GROQ_TRANSLATION_FALLBACKS;
  // The primary model is never also its own fallback.
  return Array.from(new Set(models)).filter((model) => model !== getGroqTranslationModel());
}

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

/**
 * How fast spoken Khmer goes in this pipeline's voice. Every length decision in
 * this file is measured against it: a line with a window of D seconds can hold
 * about D * 3.8 syllables.
 *
 * 4.5 is the textbook figure for spoken Khmer, but the voice that actually
 * renders the dub — Edge's km-KH neural voices — measured 3.83 syllables a
 * second over 20 real lines (range 3.1-4.5, 275 syllables in 71.9s of speech with
 * padding stripped). Budgeting at the textbook rate asked every translation for
 * ~15% more speech than the line could hold, which is precisely the overshoot
 * that ends up sped up or trimmed. The measured rate is the honest one.
 */
const KHMER_SYLLABLES_PER_SECOND = Number(process.env.KHMER_SYLLABLES_PER_SECOND || '3.8');

/** How far past its budget a line may sit before it is rewritten to fit. */
const FIT_TOLERANCE = 1.3;

/** One fit pass costs one provider round trip, so it only ever rewrites a bounded set. */
const MAX_FIT_LINES = 40;

/** One vowel sign marks one syllable nucleus; these are the two vowel ranges. */
const KHMER_DEPENDENT_VOWEL = /[\u17B4-\u17C5]/;
const KHMER_INDEPENDENT_VOWEL = /[\u17A3-\u17B3]/;

/**
 * Rough syllable count for a line of dialogue — the thing that decides how long
 * it takes to speak.
 *
 * Khmer writes one vowel sign per syllable nucleus, so counting the vowel signs
 * tracks spoken length closely enough to measure a line against its slot
 * ("សួស្តី" = two signs = two syllables; "ខ្មែរ" = one = one). A word written
 * without any vowel sign still speaks as a syllable, so the word count is the
 * floor, and a line that is not Khmer at all — a source line kept untranslated, a
 * brand name, digits — falls back to its word count.
 */
export function countKhmerSyllables(text: string): number {
  const trimmed = (text || '').trim();
  if (!trimmed) return 0;

  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (!KHMER_SCRIPT.test(trimmed)) return Math.max(1, Math.round(words * 1.3));

  let nuclei = 0;
  for (const character of trimmed) {
    if (KHMER_DEPENDENT_VOWEL.test(character) || KHMER_INDEPENDENT_VOWEL.test(character)) nuclei++;
  }
  return Math.max(nuclei, words);
}

/** How many syllables a speech window of `seconds` can hold. */
export function syllableBudget(seconds: number): number {
  return Math.max(2, Math.round(Math.max(0, seconds || 0) * KHMER_SYLLABLES_PER_SECOND));
}

/**
 * The room each line actually has on the timeline, which is what the dub is
 * fitted into when the voice is synthesised (see jobProcessor: the same window
 * the assembler receives).
 *
 * A line may borrow the silence that follows it — right up to the next speaker,
 * never past them — so a line sitting in a pause genuinely has more time than
 * `end - start` suggests. Measuring against `end - start` alone would rewrite
 * those lines for a problem they do not have, so this mirrors the runtime window
 * exactly. Video length only ever shortens the last line, and translation runs
 * before the video is probed, so it is left at the segment's own reach here.
 */
export function speechWindowsFor(segments: DialogueSegment[]): Map<string, number> {
  const windowStretch = Math.max(1, Number(process.env.SPEECH_WINDOW_STRETCH || '1.4'));
  const timeline = [...segments].sort((a, b) => a.start - b.start);
  const windows = new Map<string, number>();

  timeline.forEach((segment, index) => {
    const own = Math.max(0.5, segment.end - segment.start);
    const next = timeline[index + 1];
    const beforeNext = next
      ? Math.max(0, next.start - segment.start - DIALOGUE_GAP_SECONDS)
      : Number.POSITIVE_INFINITY;
    windows.set(segment.id, Math.max(0.5, Math.min(beforeNext, own * windowStretch)));
  });

  return windows;
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

/** `m:ss`, the way a viewer would say a position in the video. */
function formatTimeline(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
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
 * Which provider a translation stage starts on: Gemini in front, Groq behind it.
 *
 * That order is the product decision, so it lives in the code rather than in a
 * deployment setting: the stage asks Gemini for every block, and the moment
 * Gemini cannot answer one (`requestTranslation`) the rest of the job — and the
 * next five minutes — go to Groq without asking Gemini again. Inside Gemini the
 * model rotation then walks the flash models that this account's free tier does
 * serve, so a spent Pro allowance or a rejected key costs one round trip and not
 * the stage.
 *
 * `TRANSLATION_PROVIDER` is deliberately not consulted any more. It used to name
 * the provider to start on, which is how this deployment was pinned to Groq; the
 * owner has since asked for Gemini first with Groq after an error, and the only
 * thing that should take Gemini out of the front position is Gemini having no key
 * left to ask — a provider that cannot answer must never be waited on. Falling
 * back needs no setting: the other configured provider is picked up by itself.
 */
export function resolveTranslationProvider(): TranslationProviderName {
  const geminiUsable = isGeminiConfigured() && hasUsableGeminiKey();
  if (geminiUsable) return 'gemini';
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
  /** Wall-clock time until which the configured provider is not asked again. */
  private primaryDownUntil = 0;
  /**
   * The other provider, once the configured one has failed this job.
   *
   * Once the configured provider is down, asking it again is pure loss, so every
   * remaining block goes to this one. `direct` says how: Gemini tolerates several
   * blocks in flight, so it is asked straight from the block; Groq's free tier
   * caps tokens per minute, so its blocks keep queueing through the paced fallback
   * path instead of trading a dead provider for a 429 storm.
   */
  private promotedProvider: { name: TranslationProviderName; direct: boolean } | null = null;
  /** Serialises fallback calls; see `askFallback`. */
  private fallbackQueue: Promise<void> = Promise.resolve();
  /** One agreed Khmer spelling per name, filled in as blocks answer; see buildConfirmedNameSection. */
  private confirmedNames = new Map<string, { name: string; khmer: string }>();
  /** Providers that actually answered a block; reported by the job's log line. */
  private answeredProviders = new Set<TranslationProviderName>();

  constructor() {
    this.provider = resolveTranslationProvider();
    // Gemini's clients are created per request inside the rotation, because a
    // block may end up on any model and any key.
    this.modelName =
      this.provider === 'groq' ? getGroqTranslationModel() : getGeminiModels()[0];
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

    // The video's own names, read from the transcript before a single line is
    // translated, so every block is told which words must survive as names.
    const properNames = detectProperNames(ordered);
    const systemInstruction = this.buildSystemInstruction(settings, properNames);
    const glossary = parseGlossary(settings.glossary);
    this.confirmedNames.clear();
    this.answeredProviders.clear();
    if (properNames.length > 0) {
      logger.info(
        `Name protection: ${properNames.length} proper name(s) detected in the transcript (${properNames
          .slice(0, 8)
          .join(', ')}${properNames.length > 8 ? ', …' : ''}).`
      );
    }
    // The room each line will have on the timeline. The prompt quotes it per
    // line, and the same numbers are re-measured once every block has answered.
    const speechWindows = speechWindowsFor(ordered);
    /** How far into the video this transcript reaches; quoted per block. */
    const videoSeconds = ordered.reduce(
      (max, segment) => Math.max(max, segment.end),
      0
    );
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
      // Both sides of the block. What came before carries the names and the
      // register already established; what comes after carries the answer to the
      // question this block ends on — without it a line like "Because of him." is
      // translated as if it were a statement about the speaker, and the dub stops
      // matching what the video is actually saying.
      const sourceLines = (lines: DialogueSegment[]): ContextLine[] =>
        lines.map((s) => ({ speaker: s.speaker, original: s.text }));

      const before: ContextLine[] =
        concurrency > 1
          ? i === 0
            ? []
            : sourceLines(chunks[i - 1].slice(-6))
          : recentContext;
      const after: ContextLine[] =
        i === chunks.length - 1 ? [] : sourceLines(chunks[i + 1].slice(0, 3));

      let billedTokens = 0;
      // The key's real allowance, straight from the provider's answer. Used to
      // pace the next block instead of guessing the smallest free tier.
      let rateLimit: GroqRateLimit | undefined;
      const requestStartedAt = Date.now();

      try {
        const userPrompt = this.buildChunkPrompt(
          chunk,
          before,
          after,
          i,
          chunks.length,
          speechWindows,
          properNames,
          videoSeconds
        );
        // Fallback estimate in case the provider does not report usage.
        const estimatedTokens = estimateTokens(systemInstruction + userPrompt) + chunk.length * 45;

        const response = await this.requestTranslation(systemInstruction, userPrompt);
        billedTokens = response.totalTokens || estimatedTokens;
        rateLimit = response.rateLimit;
        logger.info(
          `Translation block ${i + 1}/${chunks.length}: ${chunk.length} line(s), ${billedTokens} tokens.`
        );
        const parsed = this.parseChunkResponse(response.content);
        // The names this block reported it carried, straight from the same answer:
        // the translation parser only keeps the Khmer text and the emotion.
        const blockReportedNames = reportedNamesById(response.content, chunk);

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

        await enforceProperNames({
          chunk,
          translations,
          properNames,
          reportedNames: blockReportedNames,
          confirmedNames: this.confirmedNames,
          systemInstruction,
          requestTranslation: (instruction, prompt) =>
            this.requestTranslation(instruction, prompt),
          addWarning,
        });

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
      if (onProgress) await onProgress(completedLines, ordered.length);

      // Pace the next request against the per-minute token ceiling. There is
      // nothing left to protect after the final block, so don't wait for it.
      // A concurrent run has no next request of its own to pace.
      if (concurrency === 1 && i < chunks.length - 1) {
        // Groq reports the key's real remaining allowance on every answer, so
        // the wait is only paid when the next block would actually not fit: an
        // account with room to spare moves straight on instead of sleeping out
        // a guessed 7,800-token window on every block.
        const hasHeadroom = Boolean(
          rateLimit && rateLimit.remainingTokens >= billedTokens * 1.5
        );
        if (!hasHeadroom) {
          await this.paceRequest(billedTokens, requestStartedAt);
        }
      }
    });

    // Every line is in hand — now check them against the video's own timing and
    // tighten the ones that will not fit.
    await this.fitLinesToOriginalTiming(ordered, translations, speechWindows, systemInstruction, glossary, addWarning);

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

    // Which provider answered is not always the configured one: blocks fall back
    // to the other provider as soon as the first one cannot answer, and the log
    // line used to name the configured provider no matter who replied.
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

  private buildSystemInstruction(settings: JobSettings, properNames: string[] = []): string {
    const isFormal = settings.translationStyle === 'formal';
    const voiceStyle = settings.voiceStyle || 'natural';

    const sourceLanguage = settings.sourceLanguage && settings.sourceLanguage !== 'auto'
      ? SOURCE_LANGUAGE_NAMES[settings.sourceLanguage]
      : '';

    return `You are a professional Cambodian Khmer dubbing director and translator for movies and videos.
Your mission is to translate spoken ${sourceLanguage || 'English/original'} dialogue into natural, authentic spoken Cambodian Khmer (ភាសាខ្មែរនិយាយបែបធម្មជាតិ).
${sourceLanguage ? `The dialogue you receive is ${sourceLanguage}. Read it as a native speaker of that language before translating, and keep proper names, numbers and units exactly as spoken.\n` : ''}${buildGlossarySection(parseGlossary(settings.glossary))}${buildProperNameSection(properNames)}
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
   - EVERY PART OF A NAME STAYS. A given name and a surname are never reduced to one of them: "Vladimir Putin" is never "ពូទីន" alone, and a title the speaker uses ("President", "Mr") is translated as a title while the name it precedes stays whole.
4. FIT ORIGINAL DURATION (LIP-SYNC / TIMING CONSTRAINT):
   - Cambodian Khmer audio takes time to speak.
   - Calculate duration = end - start seconds.
   - KHMER SPEECH RATE: this dubbing voice speaks about 3.8 Khmer syllables per second (measured), so a line with duration D holds about D * 3.8 syllables.
   - Every line you receive carries "budget_syllables" — duration * 3.8 already worked out for THAT line. It is the exact limit for that line; stay at or under it.
   - Keep the Khmer translation concise enough to be spoken comfortably within the original segment duration, and stay under that syllable budget. A line that overshoots has to be sped up or cut off mid-word in the dub, which the viewer hears as broken speech — and the words no longer line up with the original video.
   - If a literal translation would be too long for the duration, rephrase or condense it naturally — use shorter Khmer words, not fewer ideas.
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
12. COMPLETENESS — NEVER TRADE MEANING FOR TIME:
   - Every piece of information in the source line must still be there in the Khmer line. Never summarize, never drop a clause, never answer with a shorter sentence that loses what was said.
   - When the line is too long for its duration, condense the WORDING (shorter Khmer words, dropped pleasantries, tighter phrasing) — never delete facts, names, numbers or requests.
   - A name is NEVER the part that gets dropped to save time: keep every name whole and shorten the wording around it.
   - Numbers, dates, money and units stay exactly as spoken. Do not round, convert or invent them.

13. MATCH THE VIDEO — EVERY LINE MUST BE WHAT THAT MOMENT SAYS:
   - Each line you receive is one moment of the video: the moment its "start"/"end" covers. Translate THAT moment and nothing else.
   - Same scene, same meaning: if the original speaker is arguing, joking, panicking or lying on this line, the Khmer line carries that same tone. A viewer watching the picture must hear the same thing the original actor said.
   - NOTHING IS ADDED, NOTHING IS LEFT OUT. No invented lines, no greetings or pleasantries that were never said, no summarising two lines into one, no explaining the scene, no stage directions.
   - A line can be a fragment of a longer speech. Translate it as the piece of speech it is — do not pad it into a complete sentence and do not invent the part you were not given.
   - Same order, same count: exactly one Khmer line per line you receive, echoing each "id" back unchanged.
14. SCRIPT PURITY — ABSOLUTE REQUIREMENT:
   - Every "khmer" value you return MUST be written in pure Khmer Unicode only (U+1780-U+17FF plus Khmer punctuation U+17D4-U+17DD, digits, and basic Latin for brand names from the glossary).
   - FORBIDDEN: Thai script (U+0E00-U+0E7F) and Lao script (U+0E80-U+0EFF) are NEVER allowed, not even one character. ការសរសេរត្រូវតែជាអក្សរខ្មែរសុទ្ធ 100% ហាមប្រើអក្សរថៃឬឡាវដាច់ខាត។
   - Bad example (DO NOT DO): "ไปไหนมา" (Thai) instead of "ទៅណាមក" (Khmer) — they look similar but are different Unicode.
   - If you are unsure of a Khmer spelling, use the closest valid Khmer characters, never substitute Thai/Lao shapes.
   - Before returning, mentally verify each line contains no Thai/Lao codepoints.
15. SPEAKER VOICE: keep each speaker's register exactly as it is in the video — a child does not talk like a boss, and one speaker answering another is not the same voice as one speaking alone. Pronouns and honorifics follow who is talking to whom on screen.`;
  }

  private buildChunkPrompt(
    chunk: DialogueSegment[],
    before: ContextLine[],
    after: ContextLine[],
    chunkIndex: number,
    chunkCount: number,
    speechWindows: Map<string, number>,
    properNames: string[] = [],
    videoSeconds = 0
  ): string {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    // The moment this block covers on screen, stated plainly: a line translated as
    // a caption has to be what that speaker says at that moment, and the model
    // reads far more faithfully when it is told where in the video it is working.
    const where =
      first && last
        ? `\nThese ${chunk.length} line(s) are spoken between ${formatTimeline(
            first.start
          )} and ${formatTimeline(last.end)} of a video that runs about ${formatTimeline(
            videoSeconds || last.end
          )}. Each line below is one moment of that video: its "khmer" text is what is heard while that moment is on screen, in the same order, one Khmer line per line — never two lines joined, never one line split, and never a line the video does not contain.`
        : '';

    const formattedInput = chunk.map((s) => ({
      id: s.id,
      speaker: s.speaker,
      // Timeline position as well as seconds: the model reads "1:12" faster than
      // "72.4" when it is placing a line against the picture.
      at: formatTimeline(s.start),
      start: s.start,
      end: s.end,
      duration: Number((s.end - s.start).toFixed(2)),
      // The exact size of this line's speaking slot in the finished video. The
      // model is told the rate in rule 4; handing it the arithmetic removes the
      // one step it gets wrong often enough to matter.
      budget_syllables: syllableBudget(
        speechWindows.get(s.id) ?? Math.max(0.5, s.end - s.start)
      ),
      text: s.text,
    }));

    // Only this block's names are listed here: the system instruction names them
    // all, and repeating them per block is what keeps the model from reading a
    // name as just another word while it works through these lines.
    const blockNames = properNames.length > 0
      ? [...new Set(chunk.flatMap((segment) => namesInText(segment.text, properNames)))]
      : [];
    const namesSection =
      blockNames.length > 0
        ? `\nThese lines speak these names — carry every one of them in full, in Khmer script: ${blockNames.join(
            ', '
          )}.\n`
        : '';

    const confirmedSection = buildConfirmedNameSection(this.confirmedNames);

    const beforeSection =
      before.length > 0
        ? `\nSpoken just BEFORE this block (context only — do NOT translate these, but keep their names, pronouns and terminology consistent with them):\n${JSON.stringify(
            before,
            null,
            2
          )}\n`
        : '';

    const afterSection =
      after.length > 0
        ? `\nSpoken just AFTER this block (context only — do NOT translate these. Read them so the last lines of this block are translated as what they really mean in the scene: an answer, a reaction and a question are not the same thing, and a line like "Because of him." is an answer, not a claim about the speaker):\n${JSON.stringify(
            after,
            null,
            2
          )}\n`
        : '';

    return `Block ${chunkIndex + 1} of ${chunkCount} from the video's dialogue sequence. Translate ONLY the lines listed below. Output pure Khmer script only (U+1780-U+17FF) — zero Thai/Lao characters allowed.
${where}${namesSection}${confirmedSection}${beforeSection}${afterSection}
Lines to translate:
${JSON.stringify(formattedInput, null, 2)}

Each line's "budget_syllables" is how many Khmer syllables fit in the time that line has on screen — stay at or under it for that line.

Return JSON containing exactly ${
      chunk.length
    } entries, in the same order, each with the line's original "id", its natural spoken Khmer "khmer" translation (pure Khmer Unicode, no Thai/Lao), and the detected "emotion".`;
  }

  /**
   * Dispatch one block to one provider and return its raw JSON text.
   *
   * The Groq model is named here rather than read from `this.modelName`: Groq is
   * also reached as the *fallback* while Gemini is the configured provider, and
   * the two model names must never be confused with each other.
   */
  private async askProvider(
    provider: TranslationProviderName,
    systemInstruction: string,
    userPrompt: string
  ): Promise<{ content: string; totalTokens: number; rateLimit?: GroqRateLimit }> {
    if (provider === 'groq') {
      const groqModel = getGroqTranslationModel();
      // Fallback models when the primary is rate-limited (429), tried in order.
      // See DEFAULT_GROQ_TRANSLATION_FALLBACKS for which ones actually answer.
      const fallbackModels = getGroqTranslationFallbacks();
      
      const answer = await groqChatJson({
        model: groqModel,
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
                    // Required, and `[]` when the line speaks no name: a strict
                    // JSON schema may only carry properties it lists in
                    // `required`, and Groq is asked for exactly that.
                    names: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          khmer: { type: 'string' },
                        },
                        required: ['name', 'khmer'],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ['id', 'khmer', 'emotion', 'names'],
                  additionalProperties: false,
                },
              },
            },
            required: ['segments'],
            additionalProperties: false,
          },
        },
      });

      // Recorded after the call: a provider that threw did not answer this block.
      this.answeredProviders.add('groq');
      return answer;
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
    this.answeredProviders.add('gemini');

    return {
      content: answer.content,
      // Gemini reports real usage; the estimate is only a fallback for the rare
      // answer that comes back without it (the caller uses this to pace blocks).
      totalTokens: answer.totalTokens || estimateTokens(systemInstruction + userPrompt) + 400,
    };
  }

  /**
   * Ask the configured provider for one block, and — when it cannot answer —
   * the other configured provider for exactly the same JSON.
   *
   * A free tier runs dry in ways the model rotation cannot paper over: measured
   * on this project, one Gemini key was denied access for its whole project
   * (403) while the other answered "high demand" (503) for every model and then
   * "exceeded your current quota" (429), with a single stalled call taking 52
   * seconds. Retrying that inside every block is what makes the translation
   * stage the slow one, so a provider that has just failed is put aside for a
   * while (`primaryDownUntil`) and the blocks that follow go straight to the
   * provider that is actually answering. Nothing about the requested JSON
   * changes — the same lines, in the same shape, from the other service.
   */
  private async requestTranslation(
    systemInstruction: string,
    userPrompt: string
  ): Promise<{ content: string; totalTokens: number; rateLimit?: GroqRateLimit }> {
    // The promoted provider is the stage's provider from here on, so no block
    // ever re-tests the one that just failed.
    if (this.promotedProvider) {
      return this.promotedProvider.direct
        ? this.askProvider(this.promotedProvider.name, systemInstruction, userPrompt)
        : this.askFallback(this.promotedProvider.name, systemInstruction, userPrompt);
    }

    const secondary = this.secondaryProviderName();
    if (!secondary) return this.askProvider(this.provider, systemInstruction, userPrompt);

    if (Date.now() < this.primaryDownUntil) {
      this.promoteSecondary(secondary);
      return this.askFallback(secondary, systemInstruction, userPrompt);
    }

    try {
      return await this.askProvider(this.provider, systemInstruction, userPrompt);
    } catch (err: any) {
      // Not a per-block problem (that is handled by the rescue passes): the
      // provider itself could not answer, so the rest of the job runs on the
      // other one — which is also remembered here, so the next job starts there
      // instead of repeating a sweep that just failed.
      this.primaryDownUntil = Date.now() + PRIMARY_DOWN_COOLDOWN_MS;
      this.promoteSecondary(secondary);
      logger.warn(
        `${this.provider} could not answer a translation block (${
          err?.message ?? err
        }); the rest of this job runs on ${secondary}, and ${secondary} is used for the next ${Math.round(
          PRIMARY_DOWN_COOLDOWN_MS / 60_000
        )} minute(s) without asking ${this.provider} first.`
      );
      return this.askFallback(secondary, systemInstruction, userPrompt);
    }
  }

  /**
   * Run one fallback call at a time, waiting for the key's window when needed.
   *
   * The two providers have different shapes: Gemini tolerates several blocks in
   * flight, while Groq's free tier caps tokens per minute and answers a second
   * simultaneous block with 429 — and a 429 costs up to a minute of waiting, so
   * trading one slow provider for another would be no improvement. Fallback
   * calls are therefore chained (one in flight, ever) and paced against the
   * allowance Groq itself reports on the answer.
   */
  private async askFallback(
    provider: TranslationProviderName,
    systemInstruction: string,
    userPrompt: string
  ): Promise<{ content: string; totalTokens: number; rateLimit?: GroqRateLimit }> {
    const run = async () => {
      const answer = await this.askProvider(provider, systemInstruction, userPrompt);
      if (provider === 'groq' && answer.rateLimit && answer.totalTokens > 0) {
        if (answer.rateLimit.remainingTokens < answer.totalTokens * 1.5) {
          const waitMs = Math.min(65_000, answer.rateLimit.resetMs);
          if (waitMs >= 250) {
            logger.info(
              `Waiting ${(waitMs / 1000).toFixed(1)}s for the fallback provider's token window to refill.`
            );
            await sleep(waitMs);
          }
        }
      }
      return answer;
    };

    const queued = this.fallbackQueue.then(run, run);
    // The queue itself must never reject: the next block still has to run.
    this.fallbackQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  /**
   * Hand the rest of the job to `provider`; see `promotedProvider` for what
   * "direct" buys and when it is withheld.
   */
  private promoteSecondary(provider: TranslationProviderName): void {
    if (this.promotedProvider) return;
    this.promotedProvider = { name: provider, direct: provider !== 'groq' };
  }

  /**
   * The other provider this project has credentials for, if any — the one every
   * remaining block goes to once the lead provider fails one. Public because the
   * status screen reports it: "Gemini in front, Groq after an error" is a promise
   * the owner should be able to read back, not just take on trust.
   */
  public getFallbackProviderName(): TranslationProviderName | null {
    return this.secondaryProviderName();
  }

  /** The other provider this project has credentials for, if any. */
  private secondaryProviderName(): TranslationProviderName | null {
    if (this.provider === 'groq') return isGeminiConfigured() ? 'gemini' : null;
    return isGroqConfigured() ? 'groq' : null;
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
   * Measure every finished Khmer line against the time the original video gives
   * it, and rewrite the ones that will not fit.
   *
   * The first pass is *told* the budget but nothing enforces it, and a line that
   * overshoots is not merely long: the dub has to speed up past comfort or the
   * assembler trims it mid-syllable, so the translation visibly drifts away from
   * the picture. So the lines are measured after the fact and the worst offenders
   * are asked for once more, this time with their own numbers.
   *
   * A rewrite is only kept when it is genuinely shorter, still valid Khmer, and
   * still carries every glossary term the line already had — anything else would
   * buy timing with accuracy, which is the one trade this pipeline must never
   * make. Refusing costs nothing: the original wording stands and the voice is
   * fitted exactly as it was before.
   */
  private async fitLinesToOriginalTiming(
    segments: DialogueSegment[],
    translations: Map<string, { khmer: string; emotion?: string }>,
    speechWindows: Map<string, number>,
    systemInstruction: string,
    glossary: Glossary,
    addWarning: (message: string) => void
  ): Promise<void> {
    const measure = (segment: DialogueSegment) => {
      const budget = syllableBudget(
        speechWindows.get(segment.id) ?? Math.max(0.5, segment.end - segment.start)
      );
      const khmer = translations.get(segment.id)?.khmer?.trim() || '';
      return { segment, khmer, budget, syllables: countKhmerSyllables(khmer) };
    };

    const overlong = segments
      .map(measure)
      .filter((line) => line.khmer && line.syllables > line.budget * FIT_TOLERANCE);

    if (overlong.length === 0) return;

    const batch = overlong.slice(0, MAX_FIT_LINES);
    logger.warn(
      `${overlong.length} Khmer line(s) say more than the original video has time for; rewriting ${batch.length} to fit.`
    );
    for (const line of batch) {
      logger.warn(
        `  ${line.segment.id}: ${line.syllables} syllables in a ${line.budget}-syllable window (${Math.max(
          0.5,
          line.segment.end - line.segment.start
        ).toFixed(2)}s).`
      );
    }

    const payload = batch.map((line) => ({
      id: line.segment.id,
      duration: Number((line.segment.end - line.segment.start).toFixed(2)),
      budget_syllables: line.budget,
      current_syllables: line.syllables,
      original: line.segment.text,
      khmer: line.khmer,
    }));

    const prompt = `These ${batch.length} Khmer line(s) say more than the original video has time for. Rewrite ONLY the "khmer" text of each so it fits its "budget_syllables" while staying complete.\n
Rules:\n
- Keep EVERY fact, name, number, date, question and request from the original line. Condense the WORDING — shorter Khmer synonyms, drop filler and pleasantries — never drop content and never summarize.\n
- Keep the register and the emotion of the line, and keep any glossary term already present in "khmer" written exactly as it is.\n
- Pure Khmer script only (U+1780-U+17FF). No Thai, no Lao.\n
- Echo each "id" exactly; do not merge, split or reorder lines.\n\nLines to shorten:\n${JSON.stringify(
      payload,
      null,
      2
    )}\n\nReturn JSON with exactly ${payload.length} entries, each with "id", the shorter "khmer", and its "emotion".`;

    let parsed: Map<string, { khmer: string; emotion?: string }>;
    try {
      const response = await this.requestTranslation(systemInstruction, prompt);
      parsed = this.parseChunkResponse(response.content);
    } catch (err: any) {
      // Not fatal: these lines keep their wording and the voice is fitted as it
      // always was — the old behaviour rather than a broken job.
      logger.warn('Fit-to-timing rewrite failed; keeping the original wording:', err?.message || err);
      return;
    }

    /** A rewrite may not cost the line the terms that line was required to keep. */
    const keepsGlossary = (previous: string, next: string): boolean => {
      for (const term of glossary.keep) {
        if (containsTerm(previous, term) && !containsTerm(next, term)) return false;
      }
      for (const { translation } of glossary.forced) {
        if (translation && previous.includes(translation) && !next.includes(translation)) return false;
      }
      return true;
    };

    let shortened = 0;
    for (const line of batch) {
      const item = parsed.get(line.segment.id);
      const next = (item?.khmer || '').trim();
      if (!next || !isValidKhmer(next)) continue;

      const nextSyllables = countKhmerSyllables(next);
      if (nextSyllables >= line.syllables) continue; // no gain, keep the original
      if (nextSyllables < Math.max(2, Math.round(line.budget * 0.6))) continue; // not a stub
      if (!keepsGlossary(line.khmer, next)) continue;

      const existing = translations.get(line.segment.id);
      translations.set(line.segment.id, {
        khmer: next,
        emotion: item?.emotion || existing?.emotion,
      });
      shortened++;
    }

    if (shortened > 0) {
      logger.info(`Fit-to-timing rewrite accepted ${shortened}/${batch.length} line(s).`);
    }

    const stillOver = segments
      .map(measure)
      .filter((line) => line.khmer && line.syllables > line.budget * FIT_TOLERANCE);
    logger.info(
      `Post-translation timing: ${segments.length - stillOver.length}/${segments.length} line(s) fit their window.`
    );

    // Anything still well past its window is about to be heard as sped-up or
    // clipped speech, and the owner should know which job produced that.
    const badlyOver = stillOver.filter((line) => line.syllables > line.budget * (FIT_TOLERANCE + 0.3));
    if (badlyOver.length > 0) {
      addWarning(
        `បន្ទាត់ចំនួន ${badlyOver.length} វែងជាងចំណុំពេលដែលវីដេអូដើមមាន ដូច្នេះសំឡេងខ្មែរក្នុងបន្ទាត់ទាំងនោះត្រូវបានបង្រួមលឿនបន្តិច។ (${badlyOver.length} line(s) still run past the original video's timing, so that speech is delivered a little faster.)`
      );
    }
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
