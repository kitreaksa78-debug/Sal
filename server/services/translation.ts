import { GoogleGenAI, Type } from '@google/genai';
import { DialogueSegment, JobSettings } from '../types.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

export interface TranslationResult {
  segments: DialogueSegment[];
  summary?: string;
}

export class KhmerDubTranslationService {
  private client: GoogleGenAI | null = null;
  private modelName: string;

  constructor() {
    this.modelName = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const apiKey = process.env.GEMINI_API_KEY;
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

  public isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  /**
   * Translates dialogue segments into natural spoken Cambodian Khmer using Gemini,
   * maintaining a conversation context window to ensure consistent pronouns,
   * relationships, character voice, and duration constraints.
   */
  public async translateDialogue(
    segments: DialogueSegment[],
    settings: JobSettings
  ): Promise<DialogueSegment[]> {
    if (!this.client) {
      throw new Error('Gemini API key is not configured.');
    }

    if (segments.length === 0) {
      return [];
    }

    const isFormal = settings.translationStyle === 'formal';
    const voiceStyle = settings.voiceStyle || 'natural';

    const systemInstruction = `You are a professional Cambodian Khmer dubbing director and translator for movies and videos.
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
9. Return STRICT JSON only matching the schema.`;

    const formattedInput = segments.map((s) => ({
      id: s.id,
      speaker: s.speaker,
      start: s.start,
      end: s.end,
      duration: Number((s.end - s.start).toFixed(2)),
      text: s.text,
    }));

    const userPrompt = `Here is the conversation sequence from the video:
${JSON.stringify(formattedInput, null, 2)}

Translate each line into natural spoken Cambodian Khmer according to all dubbing rules.
Ensure dialogue length strictly fits the original duration for each segment.`;

    const translatedSegments = await withRetry(
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
                      speaker: { type: Type.STRING },
                      start: { type: Type.NUMBER },
                      end: { type: Type.NUMBER },
                      original: { type: Type.STRING },
                      khmer: { type: Type.STRING, description: 'Natural spoken Cambodian Khmer translation' },
                      emotion: { type: Type.STRING, description: 'Detected emotion (e.g. neutral, energetic, calm, dramatic)' },
                    },
                    required: ['speaker', 'start', 'end', 'original', 'khmer'],
                  },
                },
              },
              required: ['segments'],
            },
          },
        });

        const rawText = response.text?.trim() || '';
        try {
          const parsed = JSON.parse(rawText);
          if (!parsed.segments || !Array.isArray(parsed.segments)) {
            throw new Error('Response does not contain valid segments array');
          }

          // Map back to original segments
          return segments.map((orig, index) => {
            const translatedItem =
              parsed.segments.find((p: any) => p.id === orig.id) ||
              parsed.segments[index] ||
              {};

            const khmerText = (translatedItem.khmer || '').trim();
            return {
              ...orig,
              khmer: khmerText || orig.text, // fallback to original if empty
              emotion: translatedItem.emotion || 'neutral',
            };
          });
        } catch (jsonErr) {
          logger.warn('Failed to parse Gemini translation JSON, will retry once with strict instruction:', rawText);
          throw jsonErr;
        }
      },
      {
        operationName: 'Gemini Khmer Dubbing Translation',
        maxAttempts: 2,
      }
    );

    logger.info(`Successfully translated ${translatedSegments.length} dialogue lines to Cambodian Khmer.`);
    return translatedSegments;
  }
}

let translationInstance: KhmerDubTranslationService | null = null;

export function getTranslationService(): KhmerDubTranslationService {
  if (!translationInstance) {
    translationInstance = new KhmerDubTranslationService();
  }
  return translationInstance;
}
