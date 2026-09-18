import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { DialogueSegment } from '../types.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { getGeminiApiKey } from '../utils/aiKeys.js';
import { groqFetch, isGroqConfigured } from '../utils/groq.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';

export interface TranscriptionProvider {
  name: string;
  isConfigured(): boolean;
  transcribe(audioFilePath: string, durationSeconds: number): Promise<DialogueSegment[]>;
}

/**
 * Filter out non-verbal sounds and tags like [laughter], (cough), *crying*, [music], etc.
 */
export function cleanNonVerbalSounds(text: string): string {
  if (!text) return '';
  return text
    .replace(/\[(?:laughter|crying|breathing|coughing|screaming|music|sound effects?|footsteps|noise|applause|sigh|groan)\]/gi, '')
    .replace(/\((?:laughter|crying|breathing|coughing|screaming|music|sound effects?|footsteps|noise|applause|sigh|groan)\)/gi, '')
    .replace(/\*(?:laughter|crying|breathing|coughing|screaming|music|sound effects?|footsteps|noise|applause|sigh|groan)\*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class GeminiTranscriptionProvider implements TranscriptionProvider {
  name = 'gemini';
  private client: GoogleGenAI | null = null;
  private modelName: string;

  constructor() {
    this.modelName = process.env.STT_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-transcribe';
    const apiKey = process.env.STT_API_KEY || getGeminiApiKey();
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

  isConfigured(): boolean {
    return Boolean(process.env.STT_API_KEY || getGeminiApiKey());
  }

  async transcribe(audioFilePath: string, durationSeconds: number): Promise<DialogueSegment[]> {
    if (!this.client) {
      throw new Error('Gemini API key is not configured for transcription.');
    }

    const audioBuffer = fs.readFileSync(audioFilePath);
    // Limit inline audio size if too large: if > 20MB, we can compress or downsample
    const base64Audio = audioBuffer.toString('base64');

    const prompt = `You are a high-precision audio transcription and speech detection engine.
Listen carefully to the speech in this audio track.
Transcribe ONLY actual linguistic spoken dialogue.

CRITICAL RULES:
1. DO NOT transcribe or include non-verbal sounds, such as:
   - laughter, chuckles
   - crying, sobbing
   - breathing, sighs
   - coughing, throat clearing
   - screams, groans, shrieks without words
   - background music or singing without spoken words
   - sound effects, footsteps, animal sounds, noise
2. For each spoken dialogue phrase, provide:
   - speaker: "speaker_1", "speaker_2", etc. Keep consistent speaker IDs.
   - start: start time in seconds (float, e.g. 1.25)
   - end: end time in seconds (float, e.g. 3.80)
   - text: exact spoken linguistic dialogue
3. Ensure timestamps are strictly within 0.0 and ${durationSeconds.toFixed(2)} seconds.
4. Output valid JSON adhering to the schema.`;

    const segments = await withRetry(async () => {
      // Use gemini-3.5-transcribe or fallback to gemini-3.8-flash for multimodal audio processing
      const response = await this.client!.models.generateContent({
        model: this.modelName || 'gemini-3.5-transcribe',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/wav',
                data: base64Audio,
              },
            },
            {
              text: prompt,
            },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            description: 'List of spoken dialogue segments with timestamps',
            items: {
              type: Type.OBJECT,
              properties: {
                speaker: { type: Type.STRING, description: 'Speaker ID (e.g. speaker_1)' },
                start: { type: Type.NUMBER, description: 'Start timestamp in seconds' },
                end: { type: Type.NUMBER, description: 'End timestamp in seconds' },
                text: { type: Type.STRING, description: 'Spoken dialogue text' },
              },
              required: ['speaker', 'start', 'end', 'text'],
            },
          },
        },
      });

      const rawText = response.text || '[]';
      try {
        const parsed = JSON.parse(rawText);
        if (!Array.isArray(parsed)) return [];
        
        return parsed
          .map((item: any, idx: number) => {
            const cleanedText = cleanNonVerbalSounds(item.text || '');
            const start = Math.max(0, parseFloat(item.start) || 0);
            const end = Math.max(start + 0.5, parseFloat(item.end) || start + 1.0);
            return {
              id: `seg_${idx + 1}`,
              speaker: item.speaker || 'speaker_1',
              start: Number(start.toFixed(2)),
              end: Number(end.toFixed(2)),
              text: cleanedText,
            };
          })
          .filter(seg => seg.text.length > 0);
      } catch (err) {
        logger.error('Failed to parse Gemini transcription JSON:', rawText);
        throw new Error('Invalid JSON format returned from transcription model.');
      }
    }, { operationName: 'Gemini Transcription' });

    logger.info(`Transcribed ${segments.length} spoken dialogue segments.`);
    return segments;
  }
}

/**
 * Groq Whisper transcription — fast speech-to-text with per-segment timestamps.
 * The audio is transcoded to 16 kHz mono first, which keeps long videos well
 * inside Groq's upload limit and avoids sending data Whisper does not need.
 */
export class GroqTranscriptionProvider implements TranscriptionProvider {
  name = 'groq';
  private modelName: string;

  constructor() {
    this.modelName = process.env.GROQ_STT_MODEL || 'whisper-large-v3';
  }

  isConfigured(): boolean {
    return isGroqConfigured();
  }

  async transcribe(audioFilePath: string, durationSeconds: number): Promise<DialogueSegment[]> {
    const uploadPath = path.join(path.dirname(audioFilePath), `groq_stt_${Date.now()}.mp3`);

    try {
      await FFmpegHelper.execute([
        '-y',
        '-i', audioFilePath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-b:a', '48k',
        uploadPath,
      ]);

      const audioBuffer = fs.readFileSync(uploadPath);
      const formData = new FormData();
      formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' }), 'audio.mp3');
      formData.append('model', this.modelName);
      formData.append('response_format', 'verbose_json');
      formData.append('temperature', '0');
      if (process.env.STT_LANGUAGE) {
        formData.append('language', process.env.STT_LANGUAGE);
      }

      const response = await groqFetch(
        '/audio/transcriptions',
        { method: 'POST', body: formData },
        'Whisper transcription'
      );

      const data = (await response.json()) as { segments?: any[] };
      const rawSegments = Array.isArray(data.segments) ? data.segments : [];
      const noSpeechThreshold = Number(process.env.STT_NO_SPEECH_THRESHOLD || '0.6');
      const segments: DialogueSegment[] = [];

      for (const raw of rawSegments) {
        // Whisper flags music/silence per segment; drop those before translation.
        const noSpeechProb = typeof raw.no_speech_prob === 'number' ? raw.no_speech_prob : 0;
        if (noSpeechProb > noSpeechThreshold) continue;

        const cleaned = cleanNonVerbalSounds(raw.text || '');
        // Require at least one real letter so punctuation-only output is dropped.
        if (!/\p{L}/u.test(cleaned)) continue;

        const start = Math.max(0, Number(raw.start) || 0);
        const rawEnd = Math.max(start + 0.5, Number(raw.end) || start + 1);
        const end = durationSeconds > 0 ? Math.min(durationSeconds, rawEnd) : rawEnd;

        segments.push({
          id: `seg_${segments.length + 1}`,
          speaker: 'speaker_1',
          start: Number(start.toFixed(2)),
          end: Number(end.toFixed(2)),
          text: cleaned,
        });
      }

      logger.info(`Groq Whisper transcribed ${segments.length} spoken dialogue segments.`);
      return segments;
    } finally {
      if (fs.existsSync(uploadPath)) {
        try { fs.unlinkSync(uploadPath); } catch {}
      }
    }
  }
}

export class AssemblyAITranscriptionProvider implements TranscriptionProvider {
  name = 'assemblyai';
  private apiKey: string;

  constructor() {
    this.apiKey =
      process.env.ASSEMBLYAI_API_KEY ||
      process.env.STT_API_KEY ||
      process.env.AUDIO_SEPARATION_API_KEY ||
      '';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async transcribe(audioFilePath: string, durationSeconds: number): Promise<DialogueSegment[]> {
    if (!this.apiKey) {
      throw new Error('AssemblyAI API key is missing.');
    }

    logger.info(`Starting AssemblyAI transcription for ${path.basename(audioFilePath)}...`);

    // 1. Upload audio buffer directly to AssemblyAI upload API
    const audioData = fs.readFileSync(audioFilePath);
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: this.apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: audioData,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`AssemblyAI audio upload failed (${uploadRes.status}): ${errText}`);
    }

    const uploadJson = (await uploadRes.json()) as { upload_url: string };
    const uploadUrl = uploadJson.upload_url;

    // 2. Request transcription with speaker diarization enabled
    const transcriptReq = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: uploadUrl,
        speaker_labels: true,
        punctuate: true,
        format_text: true,
      }),
    });

    if (!transcriptReq.ok) {
      const errText = await transcriptReq.text();
      throw new Error(`AssemblyAI transcript request failed (${transcriptReq.status}): ${errText}`);
    }

    const transcriptJson = (await transcriptReq.json()) as { id: string };
    const transcriptId = transcriptJson.id;

    // 3. Poll for completion
    const pollingEndpoint = `https://api.assemblyai.com/v2/transcript/${transcriptId}`;
    let status = 'queued';
    let resultData: any = null;

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(pollingEndpoint, {
        headers: { authorization: this.apiKey },
      });

      if (!pollRes.ok) continue;
      resultData = await pollRes.json();
      status = resultData.status;

      if (status === 'completed') {
        break;
      } else if (status === 'error') {
        throw new Error(`AssemblyAI transcription error: ${resultData.error}`);
      }
    }

    if (status !== 'completed' || !resultData) {
      throw new Error('AssemblyAI transcription timed out.');
    }

    // 4. Map utterances / words to DialogueSegment
    const segments: DialogueSegment[] = [];
    if (Array.isArray(resultData.utterances) && resultData.utterances.length > 0) {
      resultData.utterances.forEach((utt: any, idx: number) => {
        const cleaned = cleanNonVerbalSounds(utt.text || '');
        if (cleaned) {
          segments.push({
            id: `seg_${idx + 1}`,
            speaker: utt.speaker ? `speaker_${utt.speaker.toLowerCase()}` : 'speaker_1',
            start: Number((utt.start / 1000).toFixed(2)),
            end: Number((utt.end / 1000).toFixed(2)),
            text: cleaned,
          });
        }
      });
    } else if (resultData.text) {
      // Fallback if no utterances diarized
      const cleaned = cleanNonVerbalSounds(resultData.text);
      if (cleaned) {
        segments.push({
          id: 'seg_1',
          speaker: 'speaker_1',
          start: 0,
          end: Number(durationSeconds.toFixed(2)),
          text: cleaned,
        });
      }
    }

    logger.info(`AssemblyAI transcribed ${segments.length} spoken dialogue utterances.`);
    return segments;
  }
}

export function getTranscriptionProvider(): TranscriptionProvider {
  const provider = (process.env.STT_PROVIDER || '').toLowerCase();
  const assemblyKey =
    process.env.ASSEMBLYAI_API_KEY ||
    process.env.AUDIO_SEPARATION_API_KEY;

  if (provider === 'groq' && isGroqConfigured()) {
    return new GroqTranscriptionProvider();
  }

  if (provider === 'assemblyai' || (assemblyKey && !provider)) {
    const assembly = new AssemblyAITranscriptionProvider();
    if (assembly.isConfigured()) {
      return assembly;
    }
  }

  // With no explicit provider, prefer Groq Whisper when a key is present.
  if (!provider && isGroqConfigured()) {
    return new GroqTranscriptionProvider();
  }

  // Default to high-performance Gemini Transcription
  return new GeminiTranscriptionProvider();
}
