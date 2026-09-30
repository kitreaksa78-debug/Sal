/**
 * Google AI (Gemini) backs translation, speech-to-text and Khmer text-to-speech,
 * so all three read the key(s) through these helpers.
 *
 * The variable gets named differently depending on where it was copied from
 * (Google AI Studio's quickstart uses GOOGLE_API_KEY while the SDK examples use
 * GEMINI_API_KEY), so accept the common names instead of failing on a mismatch.
 *
 * A free-tier key runs out of quota per model, per day, which is why more than
 * one key can be listed (`GEMINI_API_KEY2`, `GEMINI_API_KEY3`, …). The rotation
 * that walks through them lives in `gemini.ts`; the single-key callers (STT and
 * TTS) keep using `getGeminiApiKey()`.
 */
const GEMINI_KEY_VARIABLES = [
  'GEMINI_API_KEY',
  'GEMINI_API_KEY2',
  'GEMINI_API_KEY_2',
  'GEMINI_API_KEY3',
  'GEMINI_API_KEY_3',
  'GOOGLE_API_KEY',
  'GOOGLE_API_KEY2',
  'GOOGLE_API_KEY_2',
  'GOOGLE_GENAI_API_KEY',
];

/** Every configured key, in priority order, with duplicates removed. */
export function getGeminiApiKeys(): string[] {
  const keys = GEMINI_KEY_VARIABLES.map((name) => process.env[name]?.trim()).filter(
    (key): key is string => Boolean(key)
  );

  return Array.from(new Set(keys));
}

/** The first configured key — what a plain `GoogleGenAI` client needs. */
export function getGeminiApiKey(): string | undefined {
  return getGeminiApiKeys()[0];
}
