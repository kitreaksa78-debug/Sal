import fs from 'fs';
import path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { getDatabase } from './db.js';
import { getStorage, resolveStoredArtifact } from './storage.js';
import {
  JobCancelledError,
  KHMER_CANCELLED_MESSAGE,
  jobEvents,
  muxStemOverVideo,
} from './separationJob.js';
import { generateGeminiJson } from './geminiPool.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';
import { DialogueSegment, JobRecord, KhmerDubReport } from '../types.js';

/**
 * «បកប្រែជាខ្មែរ · បង្កើតបទថ្មី» — the voice stem, sung again in Khmer.
 *
 * This runs on a finished *separation*, never on an upload: the studio already
 * holds the two halves this needs — the voice alone (what is being sung) and the
 * music alone (what it is sung over). Gemini listens to the voice, writes down
 * the lines and translates them into Khmer; a Khmer text-to-speech voice speaks
 * each line back into the slot the original line occupied; FFmpeg lays those
 * slots over the separated music and out comes the same song with a Khmer
 * vocal.
 *
 * The timings are the whole trick. A translated line is never exactly as long as
 * the phrase it replaces, so every line is sped up (never slowed) until it fits
 * its slot, and if it still does not fit the next line starts after it rather
 * than on top of it — two Khmer voices talking over each other sound far worse
 * than a line arriving a beat late.
 */

/** How much of the voice goes to Gemini in one request. */
const CHUNK_SECONDS = Math.max(20, Number(process.env.KHMER_DUB_CHUNK_SECONDS || 45));
/** Lines longer than this are split by the model's own sentence, not by us. */
const MAX_CHUNKS = 40;
/** How many parts are heard at the same time. */
const CONCURRENCY = Math.max(1, Number(process.env.KHMER_DUB_CONCURRENCY || 3));
/** A model that answers takes seconds; one that hangs is parked by the pool. */
const ANALYSIS_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.KHMER_DUB_TIMEOUT_MS || 45_000)
);
/** How many lines one job may voice — a whole album is not one request. */
const MAX_LINES = 240;
/** A hurried voice is still a voice: past this it stops sounding human. */
const MAX_TEMPO = 1.8;
/** Shorter than this and there is nothing to say. */
const MIN_LINE_SECONDS = 0.35;

/** The two Khmer voices the platform offers, both from the same TTS service. */
export const KHMER_VOICES: Record<'female' | 'male', { id: string; label: string }> = {
  female: { id: 'km-KH-SreymomNeural', label: 'សំឡេងស្រី' },
  male: { id: 'km-KH-PisethNeural', label: 'សំឡេងប្រុស' },
};

export function isKhmerVoice(value: unknown): value is 'female' | 'male' {
  return value === 'female' || value === 'male';
}

const KHMER_MESSAGES = {
  reading: 'កំពុងអានសំឡេងដែលបានញែក...',
  listening: 'Gemini កំពុងស្តាប់បទចម្រៀង និងបកប្រែជាខ្មែរ...',
  voicing: 'កំពុងបង្កើតសំឡេងខ្មែរ...',
  fitting: 'កំពុងតម្រូវសំឡេងខ្មែរឲ្យចូលចង្វាក់ដើម...',
  mixing: 'កំពុងលាយសំឡេងខ្មែរជាមួយភ្លេង...',
  done: 'បទថ្មីរួចរាល់! សំឡេងខ្មែរ លើភ្លេងដើម — អ្នកអាចស្តាប់ និងទាញយកបានហើយ។',
};

/** The jobs this process is dubbing right now. */
const activeJobs = new Set<string>();

const TRANSLATION_PROMPT = (
  index: number,
  count: number,
  lengthSeconds: number
) => `You are dubbing a song into Khmer.

You are hearing part ${index} of ${count} of a VOCAL-ONLY track: one performer's voice, singing or speaking, with the music already removed. This part is ${lengthSeconds.toFixed(
  1
)} seconds long.

Do two things, line by line:
1. Write down what is sung or spoken, in the original language, exactly as heard.
2. Translate each line into natural spoken Khmer — the way a Khmer singer would actually say that line, not a word-for-word rendering. Keep it short enough to be sung in the same breath.

Rules — follow them exactly:
- Times are in seconds from the START OF THIS PART (0 = the first sample you hear), accurate to about 0.1 s.
- One entry per sung phrase or sentence. If a phrase is a single held note, one entry is enough.
- Each entry must last at least 0.4 s. Merge pauses and breaths into the neighbouring entry; skip stretches with no words at all.
- "khmer" must be Khmer script only. Names and brands that must stay as they are may stay in Latin letters, nothing else.
- Never leave "khmer" empty: every entry you return must carry its Khmer line. If a word is unclear, translate the phrase as a whole from what surrounds it rather than dropping it.
- Return every line in order; do not summarise or skip verses.
- If this part holds no words at all (only breathing, humming or silence), answer {"lines": []}.

Answer with JSON only, in this exact shape, with no explanation before or after it:
{"lines":[{"start":0.0,"end":3.2,"text":"what is sung, original language","khmer":"អ្វីដែលច្រៀងជាភាសាខ្មែរ"}]}`;

/** Accept seconds, milliseconds or a mm:ss string; return seconds. */
function toSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const clock = /^(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Turn one part's answer into lines with absolute times.
 *
 * A model that answers in milliseconds (a 40-second part answered with 4200) is
 * rescaled, not clamped, and lines without Khmer text are dropped: a line nobody
 * can voice would only take up a slot.
 */
function readLines(
  value: unknown,
  partLength: number,
  offset: number,
  partIndex: number
): DialogueSegment[] {
  const raw = (value ?? {}) as any;
  const list = Array.isArray(raw.lines)
    ? raw.lines
    : Array.isArray(raw.segments)
    ? raw.segments
    : [];

  const looksLikeMs = list.some((item: any) => {
    const start = toSeconds(item?.start);
    return start !== null && start > partLength * 1.5 && start <= partLength * 1500;
  });

  const lines: DialogueSegment[] = [];
  list.forEach((item: any, position: number) => {
    const khmer =
      typeof item?.khmer === 'string'
        ? item.khmer.trim()
        : typeof item?.translation === 'string'
        ? item.translation.trim()
        : '';
    if (!khmer) return;

    const rawStart = toSeconds(item?.start);
    const rawEnd = toSeconds(item?.end);
    if (rawStart === null || rawEnd === null) return;

    const scale = looksLikeMs ? 1 / 1000 : 1;
    const start = Math.max(0, Math.min(partLength, rawStart * scale));
    const end = Math.max(start + MIN_LINE_SECONDS, Math.min(partLength, rawEnd * scale));
    if (end - start < MIN_LINE_SECONDS) return;

    lines.push({
      id: `p${partIndex}_${position}`,
      speaker: 'singer',
      start: Number((offset + start).toFixed(2)),
      end: Number((offset + end).toFixed(2)),
      text: typeof item?.text === 'string' ? item.text.trim() : '',
      khmer,
    });
  });

  return lines;
}

interface VoicedLine {
  segment: DialogueSegment;
  wavPath: string;
  /** Where this line lands on the finished timeline, in seconds. */
  start: number;
  duration: number;
  tempo: number;
}

/** Which engine actually spoke a line. */
export type SpeechEngine = 'edge' | 'google';

/** The neural voice first: it is the one that sounds like a Khmer singer. */
async function speakWithEdgeNeural(
  text: string,
  voiceId: string,
  directory: string
): Promise<string> {
  const tts = new MsEdgeTTS();
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  try {
    const work = (async () => {
      await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioFilePath } = await tts.toFile(directory, text);
      if (!audioFilePath || !fs.existsSync(audioFilePath)) {
        throw new Error('the speech service returned no audio');
      }
      return audioFilePath;
    })();

    // The Edge voice is a WebSocket that occasionally just stops answering; a
    // line that never arrives must not hold the whole song.
    const timeout = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('the Edge voice timed out')), 20_000);
    });
    return await Promise.race([work, timeout]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    try {
      tts.close();
    } catch {}
  }
}

/** Google Translate's own speech endpoint speaks Khmer too — no key, no socket. */
const GOOGLE_TTS_CHARS = 170;

async function speakWithGoogle(text: string, target: string): Promise<string> {
  const url =
    'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=km&q=' +
    encodeURIComponent(text);
  const response = await fetch(url, {
    headers: {
      // The endpoint answers a browser, and only a browser.
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: 'https://translate.google.com/',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Google TTS refused the line (${response.status})`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 512) throw new Error('Google TTS returned no audio');
  fs.writeFileSync(target, audio);
  return target;
}

/** Split a line the endpoint would truncate, so nothing is left unsaid. */
function splitForGoogle(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= GOOGLE_TTS_CHARS) return [cleaned];

  const pieces: string[] = [];
  let current = '';
  for (const word of cleaned.split(' ')) {
    if ((current + ' ' + word).trim().length > GOOGLE_TTS_CHARS) {
      if (current) pieces.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/**
 * Speak one Khmer line.
 *
 * The neural voice is tried first because it is the one worth listening to on a
 * song. Some networks — and some hosts' egress IPs — are refused by that
 * service, so the keyless Google Translate voice is the fallback instead of a
 * failed job: a plainer voice is still the song, in Khmer.
 */
export async function synthesizeKhmerLine(
  text: string,
  voiceId: string,
  directory: string
): Promise<{ file: string; engine: SpeechEngine }> {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new Error('nothing to say');

  try {
    return { file: await speakWithEdgeNeural(cleaned, voiceId, directory), engine: 'edge' };
  } catch (err: any) {
    logger.warn(
      `The neural Khmer voice was unavailable (${err?.message || err}); using the fallback voice.`
    );
  }

  const pieces = splitForGoogle(cleaned);
  const files: string[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const target = path.join(directory, `google_${index}.mp3`);
    files.push(await speakWithGoogle(pieces[index], target));
  }

  if (files.length === 1) return { file: files[0], engine: 'google' };

  // Google speaks a limited number of characters per request; a long line comes
  // back as several files and is joined here so the mixer still sees one line.
  const list = path.join(directory, 'concat.txt');
  fs.writeFileSync(list, files.map((file) => `file '${file}'`).join('\n'), 'utf8');
  const joined = path.join(directory, 'joined.mp3');
  await FFmpegHelper.execute([
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-codec:a', 'libmp3lame', '-q:a', '2',
    joined,
  ]);
  return { file: joined, engine: 'google' };
}

export class KhmerDubProcessor {
  static isActive(jobId: string): boolean {
    return activeJobs.has(jobId);
  }

  /**
   * Build the Khmer version of one separation. Like every other processor here
   * it never throws out of the function: the reason is written onto the job, so
   * the studio shows a red card instead of a spinner that never stops.
   */
  static async processJob(jobId: string): Promise<void> {
    if (activeJobs.has(jobId)) return;
    const db = getDatabase();
    const initial = await db.getJob(jobId);
    if (!initial) return;

    activeJobs.add(jobId);
    const workDir = path.join(process.cwd(), 'data', 'processing', jobId);
    fs.mkdirSync(workDir, { recursive: true });

    const update = async (updates: Partial<JobRecord>) => {
      const updated = await db.updateJob(jobId, updates);
      if (updated) jobEvents.emit(`job:${jobId}`, updated);
    };

    const checkpoint = async () => {
      const fresh = await db.getJob(jobId);
      if (fresh?.cancelRequested) throw new JobCancelledError();
    };

    try {
      const job = initial;
      const voice = isKhmerVoice(job.khmerVoice) ? job.khmerVoice : 'female';
      const voiceId = KHMER_VOICES[voice].id;

      logger.info(`Dubbing ${job.originalFilename} to Khmer (${job.id}, ${voice})`);

      // ------------------------------------------------------------ sources
      await update({
        status: 'extracting_audio',
        progress: 6,
        message: 'Reading the separated voice...',
        khmerMessage: KHMER_MESSAGES.reading,
      });
      await checkpoint();

      const vocalsSource = await resolveStoredArtifact(job.vocalsFile, 'outputs');
      if (!vocalsSource) {
        throw new Error(
          'រកសំឡេងដែលបានញែកមិនឃើញទេ។ សូមញែកសំឡេងម្តងទៀត។ (The separated voice is no longer stored.)'
        );
      }
      const musicSource = await resolveStoredArtifact(job.musicFile, 'outputs');

      const vocalsWav = path.join(workDir, 'vocals.wav');
      await FFmpegHelper.extractAudio(vocalsSource, vocalsWav);
      const duration = await FFmpegHelper.getAudioDuration(vocalsWav);
      if (!duration || duration <= 0) {
        throw new Error('the separated voice is empty');
      }

      // ------------------------------------------------------------ listen
      const chunkCount = Math.min(MAX_CHUNKS, Math.max(1, Math.ceil(duration / CHUNK_SECONDS)));
      const partLength = duration / chunkCount;

      await update({
        status: 'transcribing',
        progress: 12,
        message: `Listening for the words with Gemini (${chunkCount} part${
          chunkCount === 1 ? '' : 's'
        })...`,
        khmerMessage: KHMER_MESSAGES.listening,
        metadata: { ...(job.metadata || { duration, sizeBytes: 0 }), duration },
      });

      const parts: { index: number; start: number; length: number }[] = [];
      for (let index = 0; index < chunkCount; index++) {
        const start = index * partLength;
        const length = Math.min(partLength, duration - start);
        if (length > 0.5) parts.push({ index, start, length });
      }

      const segments: DialogueSegment[] = [];
      let servedModel = '';
      let servedKey = '';
      let failedChunks = 0;
      let completedParts = 0;
      let nextPart = 0;

      const hearPart = async (part: { index: number; start: number; length: number }) => {
        await checkpoint();

        const chunkPath = path.join(workDir, `part_${part.index}.mp3`);
        // Mono 16 kHz is enough to make out words: a 45-second part is around
        // 300 KB instead of megabytes of WAV in the request body.
        await FFmpegHelper.execute([
          '-y', '-v', 'error',
          '-ss', part.start.toFixed(3),
          '-t', part.length.toFixed(3),
          '-i', vocalsWav,
          '-vn',
          '-ac', '1',
          '-ar', '16000',
          '-codec:a', 'libmp3lame',
          '-b:a', '64k',
          chunkPath,
        ]);

        try {
          const result = await generateGeminiJson<DialogueSegment[]>({
            prompt: TRANSLATION_PROMPT(part.index + 1, parts.length, part.length),
            audio: {
              base64: fs.readFileSync(chunkPath).toString('base64'),
              mimeType: 'audio/mp3',
            },
            // A whole verse of lines with two languages each runs long; the
            // cleanup's 4096 cap was exactly what cut an answer in half before.
            maxOutputTokens: 8192,
            timeoutMs: ANALYSIS_TIMEOUT_MS,
            label: `khmer dub part ${part.index + 1}/${parts.length}`,
            parse: (value) => {
              const lines = readLines(value, part.length, part.start, part.index);
              // "Gemini heard nothing" is the one failure that looks like success,
              // so the raw answer is kept in the log when a part yields no line.
              if (!lines.length) {
                logger.warn(
                  `Khmer dub part ${part.index + 1} returned no usable line: ${JSON.stringify(
                    value
                  ).slice(0, 700)}`
                );
              }
              return lines;
            },
          });
          servedModel = result.model;
          servedKey = result.keyLabel;
          segments.push(...result.data);
        } catch (err: any) {
          failedChunks++;
          logger.warn(
            `Khmer dub part ${part.index + 1}/${parts.length} failed: ${err?.message || err}`
          );
        } finally {
          if (fs.existsSync(chunkPath)) {
            try {
              fs.unlinkSync(chunkPath);
            } catch {}
          }
        }

        completedParts++;
        await update({
          progress: Math.min(45, 12 + Math.round((completedParts / parts.length) * 33)),
          message: `Listening for the words with Gemini... ${completedParts}/${parts.length}`,
          khmerMessage:
            parts.length > 1
              ? `${KHMER_MESSAGES.listening.replace('...', '')} — កំណាត់ ${completedParts}/${parts.length}`
              : KHMER_MESSAGES.listening,
        });
      };

      const workerCount = Math.max(1, Math.min(CONCURRENCY, parts.length || 1));
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const part = parts[nextPart++];
            if (!part) return;
            await hearPart(part);
          }
        })
      );

      if (!segments.length) {
        throw new Error(
          failedChunks
            ? 'Gemini មិនអាចអានសំឡេងនេះបានទេ។ សូមសាកល្បងម្តងទៀត។ (Gemini could not read any part of this voice.)'
            : 'រកមិនឃើញពាក្យច្រៀងក្នុងសំឡេងនេះទេ។ (No words were found in this voice track.)'
        );
      }

      // Order matters: the parts came back concurrently, and the timeline has to
      // be built in the order the song is sung.
      segments.sort((a, b) => a.start - b.start);
      const lines = segments.slice(0, MAX_LINES);
      await db.saveSegments(jobId, lines);

      await update({
        status: 'translating',
        progress: 48,
        message: `Translated ${lines.length} line(s) into Khmer`,
        khmerMessage: `បកប្រែបាន ${lines.length} បន្ទាត់ — កំពុងបង្កើតសំឡេងខ្មែរ...`,
        segments: lines,
      });
      await checkpoint();

      // ------------------------------------------------------------- voice
      await update({
        status: 'generating_voice',
        progress: 52,
        message: `Voicing ${lines.length} line(s) in Khmer...`,
        khmerMessage: KHMER_MESSAGES.voicing,
      });

      const voiced: VoicedLine[] = [];
      const usedEngines = new Set<SpeechEngine>();
      let voicedCount = 0;

      const voiceLine = async (segment: DialogueSegment) => {
        await checkpoint();

        const slot = Math.max(MIN_LINE_SECONDS, segment.end - segment.start);
        const lineDir = path.join(workDir, 'tts', segment.id);
        fs.mkdirSync(lineDir, { recursive: true });

        const speech = await synthesizeKhmerLine(segment.khmer || '', voiceId, lineDir);
        usedEngines.add(speech.engine);
        const spoken = await FFmpegHelper.getAudioDuration(speech.file);
        if (!spoken || spoken <= 0) return;

        // A Khmer line is usually longer than the phrase it replaces. Speeding
        // it up is the only honest fix: delaying the whole song is not an
        // option, and cutting words is worse than a slightly hurried voice.
        const tempo = Math.min(MAX_TEMPO, Math.max(1, spoken / slot));
        const wavPath = path.join(workDir, `line_${segment.id}.wav`);
        await FFmpegHelper.execute([
          '-y', '-v', 'error',
          '-i', speech.file,
          '-af', tempo > 1.02 ? `atempo=${tempo.toFixed(3)}` : 'anull',
          '-ac', '2',
          '-ar', '44100',
          wavPath,
        ]);

        const length = (await FFmpegHelper.getAudioDuration(wavPath)) || spoken / tempo;
        voiced.push({ segment, wavPath, start: segment.start, duration: length, tempo });
        voicedCount++;

        await update({
          progress: Math.min(80, 52 + Math.round((voicedCount / lines.length) * 28)),
          message: `Voicing the Khmer lines... ${voicedCount}/${lines.length}`,
          khmerMessage:
            lines.length > 1
              ? `${KHMER_MESSAGES.voicing.replace('...', '')} — ${voicedCount}/${lines.length}`
              : KHMER_MESSAGES.voicing,
        });
      };

      const voiceWorkers = Math.max(1, Math.min(CONCURRENCY, lines.length));
      let nextLine = 0;
      await Promise.all(
        Array.from({ length: voiceWorkers }, async () => {
          for (;;) {
            const line = lines[nextLine++];
            if (!line) return;
            try {
              await voiceLine(line);
            } catch (err: any) {
              logger.warn(`Khmer line "${line.id}" could not be voiced: ${err?.message || err}`);
            }
          }
        })
      );

      if (!voiced.length) {
        throw new Error(
          'បង្កើតសំឡេងខ្មែរបរាជ័យ។ សូមពិនិត្យអ៊ីនធឺណិត ហើយសាកល្បងម្តងទៀត។ (The Khmer speech service returned no audio.)'
        );
      }

      // --------------------------------------------------------- timeline
      await checkpoint();
      await update({
        status: 'syncing',
        progress: 82,
        message: 'Fitting the Khmer voice to the beat...',
        khmerMessage: KHMER_MESSAGES.fitting,
      });

      // Order the lines the way the song runs, then keep them from overlapping:
      // a line that overruns its slot pushes the next one back instead of
      // speaking on top of it.
      voiced.sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const line of voiced) {
        line.start = Math.max(0, Math.min(duration - 0.2, Math.max(line.start, cursor)));
        cursor = line.start + line.duration;
      }
      const placed = voiced.filter((line) => line.start < duration - 0.2);

      const timelineWav = path.join(workDir, 'khmer_voice.wav');
      const inputs: string[] = [];
      for (const line of placed) inputs.push('-i', line.wavPath);

      const delays = placed.map((line, index) => {
        const ms = Math.round(line.start * 1000);
        return `[${index}:a]adelay=${ms}|${ms}[v${index}]`;
      });
      const mixList = placed.map((_, index) => `[v${index}]`).join('');

      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        ...inputs,
        '-filter_complex',
        `${delays.join(';')};${mixList}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad[out]`,
        '-map', '[out]',
        '-t', duration.toFixed(3),
        '-ac', '2',
        '-ar', '44100',
        timelineWav,
      ]);

      // ------------------------------------------------------------- mix
      await update({
        status: 'mixing',
        progress: 90,
        message: 'Mixing the Khmer voice over the music...',
        khmerMessage: KHMER_MESSAGES.mixing,
      });
      await checkpoint();

      const mixedWav = path.join(workDir, 'khmer_song.wav');
      if (musicSource) {
        const musicWav = path.join(workDir, 'music.wav');
        await FFmpegHelper.extractAudio(musicSource, musicWav);
        // The music is already voice-free, so a plain level balance is enough —
        // the Khmer voice sits on top, the beat is pulled back a little.
        await FFmpegHelper.mixDubbedAudio(timelineWav, musicWav, mixedWav, {
          backgroundMusic: 'reduce',
          speechVolume: 1.4,
          musicVolume: 0.55,
          backgroundHasOriginalVoice: false,
        });
      } else {
        await FFmpegHelper.execute([
          '-y', '-v', 'error',
          '-i', timelineWav,
          '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
          mixedWav,
        ]);
      }

      // -------------------------------------------------------- package
      const storage = getStorage();
      const khmerMp3 = path.join(workDir, `khmer_${jobId}.mp3`);
      await FFmpegHelper.execute([
        '-y', '-v', 'error',
        '-i', mixedWav,
        '-codec:a', 'libmp3lame', '-q:a', '2',
        khmerMp3,
      ]);
      await checkpoint();

      const khmerFile = await storage.saveFile('outputs', `khmer_${jobId}.mp3`, khmerMp3);

      let khmerVideoFile: string | undefined;
      if (job.inputKind === 'video') {
        const muxed = await muxStemOverVideo(
          job.inputFile,
          mixedWav,
          path.join(workDir, `khmer_${jobId}.mp4`)
        );
        if (muxed) {
          khmerVideoFile = await storage.saveFile('outputs', `khmer_${jobId}.mp4`, muxed);
        }
      }

      const report: KhmerDubReport = {
        model: servedModel || 'gemini',
        keyLabel: servedKey || 'Key 1',
        voice,
        voiceName: voiceId,
        engine: [...usedEngines].join('+') || 'google',
        lines: lines.length,
        voiced: placed.length,
        chunks: parts.length,
        chunksFailed: failedChunks,
        spokenSeconds: Number(
          placed.reduce((sum, line) => sum + line.duration, 0).toFixed(2)
        ),
        originalSeconds: Number(duration.toFixed(2)),
      };

      await update({
        status: 'completed',
        progress: 100,
        message: 'Khmer version finished',
        khmerMessage: KHMER_MESSAGES.done,
        khmerFile,
        khmerVideoFile,
        khmer: report,
        segments: lines,
        metadata: { ...(job.metadata || { duration, sizeBytes: 0 }), duration },
        completedAt: new Date().toISOString(),
      });

      logger.info(
        `Khmer version finished for job ${jobId}: ${placed.length}/${lines.length} line(s), ${report.spokenSeconds}s of Khmer voice`
      );
    } catch (err: any) {
      const cancelled = err instanceof JobCancelledError;
      const reason = cancelled
        ? KHMER_CANCELLED_MESSAGE
        : err?.message || 'បង្កើតបទខ្មែរបរាជ័យ។ (The Khmer version failed.)';
      logger.warn(`Khmer dub ${jobId} ended: ${reason}`);

      await update({
        status: 'failed',
        progress: 100,
        message: reason,
        khmerMessage: cancelled ? KHMER_CANCELLED_MESSAGE : 'បង្កើតបទខ្មែរបរាជ័យ',
        error: reason,
        technicalError: cancelled ? undefined : String(err?.stack || err),
        cancelled,
        completedAt: new Date().toISOString(),
      });
    } finally {
      activeJobs.delete(jobId);
      await getStorage().cleanProcessingDir(jobId).catch(() => {});
    }
  }
}
