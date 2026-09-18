/**
 * Google AI (Gemini) backs translation, speech-to-text and Khmer text-to-speech,
 * so all three read the key through this single helper.
 *
 * The variable gets named differently depending on where it was copied from
 * (Google AI Studio's quickstart uses GOOGLE_API_KEY while the SDK examples use
 * GEMINI_API_KEY), so accept the common names instead of failing on a mismatch.
 */
export function getGeminiApiKey(): string | undefined {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_GENAI_API_KEY,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }

  return undefined;
}
