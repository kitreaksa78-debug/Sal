/**
 * Google AI (Gemini) keys are read through these helpers.
 *
 * Nothing in the live pipeline reaches for them any more: translation runs on
 * Groq, speech-to-text runs on Groq Whisper, and the Khmer voice is rendered by
 * the Edge voices. Only the retired Google provider modules still read a key
 * here, which is why this file exists and why it is no longer wired into
 * translation.
 *
 * The variable gets named differently depending on where it was copied from
 * (Google AI Studio's quickstart uses GOOGLE_API_KEY while the SDK examples use
 * GEMINI_API_KEY), so accept the common names instead of failing on a mismatch.
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
