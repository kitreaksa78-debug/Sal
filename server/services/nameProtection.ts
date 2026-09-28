import { DialogueSegment } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Proper names in the Khmer translation stage: which words in a transcript are
 * names, what the prompt is told about them, and the check that they survived.
 *
 * The system instruction has always carried the rule "a name is never a word to
 * translate", and the model still mangled them in production: measured on this
 * project's own pipeline, "Vladimir Putin" came back as "ផុតិន" — the given name
 * gone — because the timing rule pushes every line to condense and a name looks
 * like something a line can spare. Three things were missing, and this module is
 * all three:
 *
 *  1. **Which words are names.** Capitalization is read off the transcript itself
 *     (see `detectProperNames`) instead of hoping the model notices.
 *  2. **A contract.** Each line reports the names it carried and the Khmer
 *     spelling it used (the `names` field of the translation schema), which is
 *     what makes a dropped or mangled name visible instead of invisible.
 *  3. **A consequence.** Lines that lose a name are sent back once with the
 *     specific name spelled out, and a name that has already been spelled one way
 *     is handed to every later block so the video never uses two spellings for
 *     one person.
 *
 * The checks are deliberately one-sided: they would rather miss a bad rendering
 * than rewrite a good line, because a rewrite costs the line's timing and a
 * provider call. Every threshold below is a "this cannot possibly be the whole
 * name" bound, not an opinion about a good transliteration.
 */

/** One name a line speaks, and the Khmer spelling the model used for it. */
export interface ReportedName {
  name: string;
  /** How that name reads inside the Khmer line, e.g. "ដូណាល់ ត្រាំ". */
  khmer: string;
}

/** The translation map the pipeline carries between its passes. */
export type TranslationMap = Map<string, { khmer: string; emotion?: string }>;

/**
 * Capitalization on its own does not make a word a name.
 *
 * Every sentence starts with a capital letter, and titles, days and months are
 * capitalized too. Feeding those to the model as "names never to translate" would
 * protect "Well" and "Tomorrow" from being translated at all, so they are kept out
 * of the detected list. The list is deliberately generous: a missing entry costs a
 * name being translated, a wrong entry costs nothing but prompt noise.
 */
const NOT_A_NAME = new Set<string>([
  'a', 'about', 'after', 'again', 'against', 'ah', 'all', 'almost', 'along', 'already',
  'also', 'although', 'always', 'am', 'an', 'and', 'another', 'any', 'anybody', 'anyone',
  'anything', 'anywhere', 'are', 'around', 'as', 'ask', 'at', 'away', 'back', 'be',
  'because', 'been', 'before', 'behind', 'being', 'believe', 'below', 'best', 'better',
  'between', 'big', 'both', 'bring', 'but', 'by', 'call', 'came', 'can', 'cannot', 'could',
  'come', 'course', 'day', 'days', 'dead', 'did', 'do', 'does', 'doing', 'done', 'down',
  'during', 'each', 'early', 'either', 'else', 'enough', 'even', 'ever', 'every',
  'everybody', 'everyone', 'everything', 'exactly', 'except', 'far', 'feel', 'few', 'find',
  'fine', 'first', 'for', 'from', 'get', 'give', 'go', 'going', 'gone', 'good', 'got',
  'great', 'guy', 'guys', 'had', 'half', 'has', 'have', 'having', 'he', 'hello', 'help',
  'her', 'here', 'hers', 'herself', 'hey', 'hi', 'him', 'himself', 'his', 'hold', 'how',
  'however', 'i', 'if', 'in', 'inside', 'into', 'is', 'it', 'its', 'itself', 'just', 'keep',
  'kind', 'know', 'last', 'late', 'later', 'leave', 'let', 'life', 'like', 'listen',
  'little', 'long', 'look', 'lot', 'made', 'make', 'man', 'many', 'maybe', 'me', 'might',
  'mine', 'moment', 'more', 'most', 'much', 'must', 'my', 'myself', 'need', 'never', 'new',
  'next', 'nice', 'night', 'no', 'nobody', 'none', 'nothing', 'now', 'of', 'off', 'oh',
  'ok', 'okay', 'on', 'once', 'one', 'only', 'open', 'or', 'other', 'others', 'our', 'ours',
  'out', 'over', 'own', 'people', 'perhaps', 'please', 'put', 'quite', 'really', 'right',
  'said', 'same', 'say', 'saw', 'see', 'seem', 'seen', 'she', 'should', 'since', 'sit', 'so',
  'some', 'somebody', 'someone', 'something', 'sometimes', 'sorry', 'still', 'stop', 'such',
  'sure', 'take', 'talk', 'tell', 'than', 'thank', 'thanks', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'thing', 'things',
  'think', 'this', 'those', 'though', 'through', 'time', 'times', 'to', 'today', 'together',
  'tomorrow', 'tonight', 'too', 'took', 'toward', 'try', 'turn', 'under', 'until', 'up',
  'upon', 'us', 'use', 'very', 'wait', 'want', 'was', 'watch', 'way', 'we', 'well', 'went',
  'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who', 'whole', 'whom',
  'why', 'will', 'with', 'without', 'woman', 'would', 'yeah', 'yes', 'yet', 'you', 'young',
  'your', 'yours', 'yourself', 'yesterday', 'morning', 'evening', 'afternoon', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
  'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'mr', 'mrs', 'ms', 'miss', 'sir', 'madam', 'god', 'jesus', 'lord',
]);

/** Words that only introduce a name ("the White House", "this John") and never name anyone. */
const NAME_DETERMINERS = new Set<string>(['the', 'a', 'an', 'this', 'that', 'these', 'those']);

/** A capitalized word: "Putin", "Xi", "O'Brien", "Al-Assad". */
const CAPITALIZED_WORD = /\p{Lu}[\p{L}'’-]*/gu;

/** What ends a sentence, so the capital that follows it is just a new sentence. */
const SENTENCE_BREAK = /[.!?…:;"'“”‘’()\[\]{}—–\n\r\t]/;

/** Total letters in a name, ignoring spaces, hyphens and apostrophes. */
export function nameLetters(name: string): number {
  return (name.match(/\p{L}/gu) || []).length;
}

/**
 * The length of a Khmer spelling, counted in Khmer characters.
 *
 * Not `nameLetters`: Khmer vowels and the coeng sign (្រ, ា, ី, …) are combining
 * marks, not letters, so counting letters would score the perfectly spelled
 * "វ្លាឌីមៀ ពូទីន" at 7 against the 13 letters of "Vladimir Putin" and flag it as
 * half a name. Every character of a Khmer spelling is a character the voice has
 * to pronounce.
 */
export function khmerLength(text: string): number {
  return (text.match(/[\u1780-\u17FF]/g) || []).length;
}

/** How many names one video may carry into the prompt; beyond this it is just noise. */
const MAX_DETECTED_NAMES = 60;

/** Khmer text, and the Thai/Lao characters the model sometimes substitutes for it. */
const KHMER_SCRIPT = /[\u1780-\u17FF]/;
const FOREIGN_SCRIPT = /[\u0E00-\u0E7F\u0E80-\u0EFF]/g;

/**
 * How much of a name's letters a Khmer rendering has to account for.
 *
 * Khmer spelling of a foreign name is not shorter than the Latin original: a
 * syllable costs at least one base character, usually two or three with its
 * vowels. "ដូណាល់ ត្រាំ" for "Donald Trump" writes 11 characters for 11 letters,
 * while the observed failure "ផុតិន" for "Vladimir Putin" writes 5 for 13 — so a
 * rendering below this share of the original cannot be the whole name.
 */
const NAME_COVERAGE_RATIO = 0.6;

/** Names shorter than this are left to the prompt: a length check cannot judge them. */
const MIN_CHECKED_NAME_LETTERS = 8;

/** True when `text` contains `term` as a whole word, ignoring case. */
function containsTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * The proper names a transcript speaks, read straight out of its own text.
 *
 * Detection is deterministic and local: capitalized words, joined when they stand
 * next to each other ("Vladimir Putin"), a lone capitalized word accepted only
 * when it also appears away from the start of a sentence ("Trump" mid-line, not
 * "Talking" opening one), and everything in `NOT_A_NAME` left out. A name said
 * often sorts first; so does a long one, because a long name is the one a line is
 * tempted to shorten.
 */
export function detectProperNames(segments: { text: string }[]): string[] {
  /** name in lower case -> how it was written, how often, and where it appeared. */
  const seen = new Map<string, { display: string; hits: number; midSentence: boolean }>();

  const accept = (words: string[], midSentence: boolean, startsSentence: boolean) => {
    // "the White House" names the same thing as "White House"; the determiner is
    // grammar wherever it stands. A run that *opens a sentence* also drops its
    // first ordinary word — "So Vladimir Putin" is a sentence start that happens
    // to sit next to a name — while the same word inside a sentence is part of the
    // name, which is what keeps "New York" whole instead of leaving "York".
    while (
      words.length > 1 &&
      (NAME_DETERMINERS.has(words[0].toLowerCase()) ||
        (startsSentence && NOT_A_NAME.has(words[0].toLowerCase())))
    ) {
      words.shift();
    }
    if (words.length === 0) return;

    const display = words.join(' ');
    const letters = nameLetters(display);
    if (letters < 3 || letters > 40) return;
    if (words.some((word) => nameLetters(word) < 2)) return;

    // A single capitalized word has to prove itself: one that only ever appears as
    // a sentence's first word is grammar, not a name.
    if (words.length === 1 && (!midSentence || NOT_A_NAME.has(display.toLowerCase()))) return;
    if (words.length > 1 && words.every((word) => NOT_A_NAME.has(word.toLowerCase()))) return;

    const key = display.toLowerCase();
    const entry = seen.get(key) || { display, hits: 0, midSentence: false };
    entry.hits += 1;
    entry.midSentence = entry.midSentence || midSentence;
    seen.set(key, entry);
  };

  for (const segment of segments) {
    const text = segment?.text || '';
    let run: { word: string; end: number; midSentence: boolean }[] = [];

    const flush = () => {
      if (run.length > 0) {
        accept(
          run.map((entry) => entry.word),
          run.some((entry) => entry.midSentence),
          !run[0].midSentence
        );
      }
      run = [];
    };

    for (const match of text.matchAll(CAPITALIZED_WORD)) {
      const word = match[0];
      const start = match.index ?? 0;
      const previous = run[run.length - 1];
      // Two capitalized words separated only by spaces are one name; anything else
      // (a comma, a verb, nothing) ends the run.
      const joined = previous && /^[\s'’-]*$/.test(text.slice(previous.end, start));
      if (!joined) flush();

      // Sentence-initial means nothing before it but a boundary or a quote.
      const before = text.slice(0, start).replace(/\s+$/, '');
      run.push({
        word,
        end: start + word.length,
        midSentence: before.length > 0 && !SENTENCE_BREAK.test(before.slice(-1)),
      });
    }
    flush();
  }

  return [...seen.values()]
    .sort((a, b) => b.hits - a.hits || b.display.length - a.display.length)
    .slice(0, MAX_DETECTED_NAMES)
    .map((entry) => entry.display);
}

/**
 * The detected names a line speaks, longest first.
 *
 * A name that is already part of a longer name in the same line is dropped:
 * "Trump" inside "Donald Trump" is the same mention, and asking the model to
 * report both would double every complaint about one name.
 */
export function namesInText(text: string, names: string[]): string[] {
  const matched = names
    .filter((name) => containsTerm(text, name))
    .sort((a, b) => b.length - a.length);

  return matched.filter(
    (name, index) => !matched.some((other, otherIndex) => otherIndex < index && containsTerm(other, name))
  );
}

/**
 * The prompt block that names the video's own names.
 *
 * The general rule was already in the system instruction and was not enough: a
 * translation fitting a syllable budget drops what it thinks is optional, and a
 * name looks optional to it. Naming the actual names, and saying outright that a
 * name is the one thing never shortened, is what the rule was missing.
 */
export function buildProperNameSection(names: string[]): string {
  if (names.length === 0) return '';

  return `\nPROPER NAMES SPOKEN IN THIS VIDEO — HIGHEST PRIORITY, APPLIES TO EVERY LINE:\n- ${names.join(
    ', '
  )}\n- A NAME IS NEVER A WORD TO TRANSLATE: never render a name by its meaning and never swap it for a different word ("Apple" the company is never ផ្លែប៉ោម; "Mark" a person is never សម្គាល់).\n- Write each name in Khmer script the way a Khmer speaker pronounces it, identically at every mention in the video.\n- Carry the WHOLE name, every part of it: "Vladimir Putin" is "វ្លាឌីមៀ ពូទីន", never just "ពូទីន"; "Donald Trump" is "ដូណាល់ ត្រាំ", never just "ត្រាំ".\n- A name is the ONE thing never shortened for time. When a line does not fit its syllable budget, condense the words around the name and keep the name complete.\n- Report every name your line speaks in its "names" field, with the Khmer spelling you used for it.\n`;
}

/**
 * The spellings this job has already committed to.
 *
 * The prompt asks for one spelling per name, but a block only sees the lines it is
 * given and the few before it — a name said in block 1 and again in block 20 was
 * free to come back spelled differently, which the viewer hears as two different
 * people. Once a line has carried a name cleanly, that exact spelling is handed to
 * every following block.
 */
export function buildConfirmedNameSection(confirmed: Map<string, { name: string; khmer: string }>): string {
  if (confirmed.size === 0) return '';

  const lines = [...confirmed.values()]
    .slice(0, 60)
    .map((entry) => `"${entry.name}" -> "${entry.khmer}"`);

  return `\nNames already spelled this way earlier in this video — reuse these exact Khmer spellings, character for character:\n${lines.join(
    '\n'
  )}\n`;
}

/** Strip Markdown fences a model may wrap its JSON in. */
function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/g, '')
    .trim();
}

/** Parse whatever JSON a model answered with, salvaging it from surrounding prose. */
function parseJsonAnswer(rawText: string): any {
  const cleaned = stripJsonFences(rawText);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/** The per-line objects of an answer, in whatever shape the model chose. */
function answerItems(parsed: any): any[] {
  if (Array.isArray(parsed?.segments)) return parsed.segments;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && ('khmer' in parsed || 'text' in parsed)) return [parsed];
  return [];
}

/** Keep only usable name reports: both fields present, nothing absurdly long. */
function normaliseNames(raw: unknown): ReportedName[] {
  if (!Array.isArray(raw)) return [];

  const names: ReportedName[] = [];
  for (const entry of raw) {
    const name = typeof (entry as any)?.name === 'string' ? (entry as any).name.trim() : '';
    const khmer = typeof (entry as any)?.khmer === 'string' ? (entry as any).khmer.trim() : '';
    if (name && khmer && nameLetters(name) <= 60) names.push({ name, khmer });
  }
  return names;
}

/**
 * The names each line of a block reported, keyed by the chunk's own line id.
 *
 * Position is the fallback when a model drops the ids, exactly as the translation
 * parser does, so a report can never be attributed to the wrong line.
 */
export function reportedNamesById(rawText: string, lines: DialogueSegment[]): Map<string, ReportedName[]> {
  const byId = new Map<string, ReportedName[]>();
  const items = answerItems(parseJsonAnswer(rawText));

  items.forEach((item: any, index: number) => {
    const names = normaliseNames(item?.names);
    if (names.length === 0) return;

    const reportedId = item?.id ? String(item.id) : '';
    const key = lines.some((line) => line.id === reportedId) ? reportedId : lines[index]?.id;
    if (key) byId.set(key, names);
  });

  return byId;
}

/** Is that Khmer spelling really in the line? Spacing around Khmer words is not reliable. */
function lineCarries(khmer: string, spelling: string): boolean {
  if (!khmer || !spelling) return false;
  if (khmer.includes(spelling)) return true;
  const squash = (text: string) => text.replace(/[\s\u200b]+/g, '');
  return squash(khmer).includes(squash(spelling));
}

/** Khmer text with any Thai/Lao characters the model slipped in removed. */
function stripForeignScript(text: string): string {
  return text.replace(FOREIGN_SCRIPT, '').replace(/\s{2,}/g, ' ').trim();
}

export interface NameEnforcementOptions {
  /** The block of lines just translated. */
  chunk: DialogueSegment[];
  /** The Khmer lines, updated in place when a rewrite is accepted. */
  translations: TranslationMap;
  /** Names detected in the whole transcript. */
  properNames: string[];
  /** What each line of this block reported carrying. */
  reportedNames: Map<string, ReportedName[]>;
  /** Spellings already agreed for this job, extended here. */
  confirmedNames: Map<string, { name: string; khmer: string }>;
  systemInstruction: string;
  requestTranslation: (systemInstruction: string, userPrompt: string) => Promise<{ content: string }>;
  addWarning: (message: string) => void;
}

/**
 * Check that every line kept its names, and ask once for the lines that did not.
 *
 * A line is a suspect when it speaks a detected name the model did not report at
 * all, when a reported spelling is not actually in the Khmer line, or when a
 * multi-part name came back far too short to be the whole name ("ផុតិន" for
 * "Vladimir Putin"). Suspects are sent back together in one focused request — the
 * same shape the glossary repair uses — and a rewrite is only accepted when it
 * fixes something without breaking the line, so a failed repair leaves the job
 * exactly as it was and only costs a warning.
 */
export async function enforceProperNames(options: NameEnforcementOptions): Promise<void> {
  const {
    chunk,
    translations,
    properNames,
    reportedNames,
    confirmedNames,
    systemInstruction,
    requestTranslation,
    addWarning,
  } = options;

  /** The source names this line speaks that the model did not account for at all. */
  const reportGaps = (segment: DialogueSegment, reported: ReportedName[]): string[] =>
    namesInText(segment.text, properNames)
      .filter((name) => !reported.some((entry) => entry.name.toLowerCase() === name.toLowerCase()))
      .map(
        (name) =>
          `"${name}" is spoken in the source line: write it in Khmer script and in full, never translate it by meaning`
      );

  /**
   * What is demonstrably wrong with the names in this Khmer line.
   *
   * Only what can be judged from the line itself: a spelling the model reported
   * but did not write, and a multi-part name that came back too short to be the
   * whole name ("ផុតិន" for "Vladimir Putin"). A name the model never reported
   * cannot be checked at all — there is nothing to look for — so that is a
   * `reportGaps` entry: a reason to ask for a rewrite, never a claim that the line
   * is wrong.
   */
  const textProblems = (khmer: string, reported: ReportedName[]): string[] => {
    const problems: string[] = [];
    if (!khmer) return problems;

    for (const entry of reported) {
      if (!lineCarries(khmer, entry.khmer)) {
        problems.push(
          `"${entry.name}" was reported as "${entry.khmer}" but that spelling is not in the Khmer line`
        );
        continue;
      }

      const parts = entry.name.trim().split(/\s+/).filter(Boolean).length;
      const letters = nameLetters(entry.name);
      const written = khmerLength(entry.khmer);
      if (
        parts >= 2 &&
        letters >= MIN_CHECKED_NAME_LETTERS &&
        written < Math.ceil(letters * NAME_COVERAGE_RATIO)
      ) {
        problems.push(
          `"${entry.name}" came back as "${entry.khmer}", which is only part of the name — carry every part of it`
        );
      }
    }

    return problems;
  };

  const suspects: { segment: DialogueSegment; khmer: string; gaps: string[]; text: string[] }[] = [];

  for (const segment of chunk) {
    const khmer = (translations.get(segment.id)?.khmer || '').trim();
    if (!khmer) continue;

    const reported = reportedNames.get(segment.id) || [];
    const gaps = reportGaps(segment, reported);
    const text = textProblems(khmer, reported);

    if (gaps.length === 0 && text.length === 0) {
      // This line got its names right, so its spelling becomes the one the rest
      // of the video must reuse.
      for (const entry of reported) {
        if (!confirmedNames.has(entry.name.toLowerCase())) {
          confirmedNames.set(entry.name.toLowerCase(), { name: entry.name, khmer: entry.khmer });
        }
      }
      continue;
    }

    suspects.push({ segment, khmer, gaps, text });
  }

  if (suspects.length === 0) return;

  const gapLines = suspects.filter((entry) => entry.gaps.length > 0).length;
  logger.warn(
    `${suspects.length} translated line(s) did not carry a proper name as required; asking for a rewrite${
      gapLines > 0 ? ` (${gapLines} of them speak a name the model never reported)` : ''
    }.`
  );
  for (const entry of suspects.slice(0, 5)) {
    logger.warn(`  ${entry.segment.id}: ${[...entry.text, ...entry.gaps].join('; ')}`);
  }

  const payload = suspects.map(({ segment, khmer, gaps, text }) => ({
    id: segment.id,
    original: segment.text,
    khmer,
    problem: [...text, ...gaps],
  }));

  const repairPrompt = `The Khmer lines below speak proper names WITHOUT carrying them correctly. Fix ONLY the "khmer" text of each line.
- Never translate a name by its meaning, and never replace it with a different word.
- Write each name in Khmer script the way a Khmer speaker pronounces it, and carry EVERY part of it (given name and surname together).
- A name is never the thing you shorten: keep the name whole and shorten the words around it.
- Keep every other fact, number and question of the line, keep the same register, and keep pure Khmer script (U+1780-U+17FF). No Thai, no Lao.
- Echo each "id" exactly; do not merge, split or reorder lines.

Lines to fix:
${JSON.stringify(payload, null, 2)}

Return JSON with exactly ${payload.length} entries, each with "id", the corrected "khmer", and its "emotion".`;

  try {
    const repaired = await requestTranslation(systemInstruction, repairPrompt);
    const parsed = new Map<string, { khmer: string; emotion?: string }>();
    /** What the rewrite says it carried; a rewrite inherits no old spelling. */
    const reportedByRewrite = new Map<string, ReportedName[]>();

    answerItems(parseJsonAnswer(repaired.content)).forEach((item: any, index: number) => {
      const entry = { khmer: String(item?.khmer ?? ''), emotion: item?.emotion };
      if (item?.id) parsed.set(String(item.id), entry);
      parsed.set(`__index_${index}`, entry);

      const names = normaliseNames(item?.names);
      if (names.length > 0) {
        if (item?.id) reportedByRewrite.set(String(item.id), names);
        reportedByRewrite.set(`__index_${index}`, names);
      }
    });

    let repairedCount = 0;

    suspects.forEach(({ segment, khmer: before, text }, index) => {
      const item = parsed.get(segment.id) || parsed.get(`__index_${index}`);
      const candidate = stripForeignScript(item?.khmer || '');
      if (!candidate || candidate === before || !KHMER_SCRIPT.test(candidate)) return;

      const rewriteReport =
        reportedByRewrite.get(segment.id) || reportedByRewrite.get(`__index_${index}`);

      // A rewrite has to be an improvement, never a trade. The line's own report
      // is stale once its text changes (it described the spelling that just went
      // away), so a repaired line is judged on the report it came back with — the
      // schema asks for one, which is also what keeps a line whose only complaint
      // was an unreported name from being refused for a spelling nobody can check
      // any more.
      if (text.length > 0) {
        if (!rewriteReport) {
          logger.info(
            `Name rewrite for ${segment.id} was refused: it came back without saying which names it carried.`
          );
          return;
        }
        if (textProblems(candidate, rewriteReport).length >= text.length) return;
      }

      translations.set(segment.id, {
        khmer: candidate,
        emotion: translations.get(segment.id)?.emotion || item?.emotion,
      });
      if (rewriteReport) reportedNames.set(segment.id, rewriteReport);
      repairedCount++;
    });

    // What is still demonstrably wrong, judged on the lines as they now stand.
    const stillBad = suspects.filter(
      (entry) =>
        textProblems(
          (translations.get(entry.segment.id)?.khmer || '').trim(),
          reportedNames.get(entry.segment.id) || []
        ).length > 0
    ).length;

    if (repairedCount > 0) {
      logger.info(`Name rewrite accepted for ${repairedCount}/${suspects.length} line(s).`);
    }
    if (stillBad > 0) {
      addWarning(
        `បន្ទាត់ចំនួន ${stillBad} មិនបានរក្សាឈ្មោះមនុស្ស ឬទីកន្លែងឲ្យពេញលេញទេ។ (${stillBad} line(s) still do not carry a proper name in full, so that name may be pronounced wrongly in the dub.)`
      );
    }
  } catch (err: any) {
    logger.warn('Name rewrite attempt failed:', err?.message || err);
    addWarning(
      `ការកែឈ្មោះឲ្យពេញលេញមិនបានសម្រេចទេ។ (Could not rewrite lines that lost a proper name: ${
        err?.message ?? 'unknown error'
      }).`
    );
  }
}
