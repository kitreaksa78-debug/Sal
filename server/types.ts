/**
 * Every state a run can be in. The site now separates voices from music and
 * reports `queued → extracting_audio → separating_audio → mixing → completed`,
 * but the dubbing-era statuses stay in the union because jobs recorded while
 * the studio translated video are still stored and still render on screen —
 * a status a saved job carries must never fall outside this type.
 */
export type JobStatus =
  | 'queued'
  | 'uploading'
  | 'extracting_audio'
  | 'separating_audio'
  | 'analyzing_audio'
  | 'cleaning_audio'
  | 'transcribing'
  | 'detecting_speakers'
  | 'translating'
  | 'generating_voice'
  | 'syncing'
  | 'mixing'
  | 'rendering'
  | 'quality_check'
  | 'completed'
  | 'failed';

export interface DialogueSegment {
  id: string;
  speaker: string;
  speakerGender?: 'male' | 'female' | 'neutral';
  start: number; // in seconds
  end: number;   // in seconds
  text: string;  // original text
  /**
   * The translated line in the job's target language. Named `khmer` for history:
   * it was Khmer-only before the target picker, and the field keeps that name so
   * stored jobs and the rest of the pipeline stay compatible.
   */
  khmer?: string;
  emotion?: string; // e.g. neutral, energetic, calm, dramatic
  audioDuration?: number; // generated audio duration in seconds
  audioFile?: string; // path to synthesized segment audio
}

export interface SpeakerInfo {
  speakerId: string;
  gender: 'male' | 'female' | 'neutral';
  segments: DialogueSegment[];
}

/** Languages the transcription step can be told to expect. `auto` lets the model guess. */
export type SourceLanguage =
  | 'auto'
  | 'en'
  | 'zh'
  | 'th'
  | 'vi'
  | 'ko'
  | 'ja'
  | 'km'
  | 'fr'
  | 'es';

/** Same codes the studio offers, used to reject anything else from a request. */
export const SOURCE_LANGUAGES: SourceLanguage[] = [
  'auto',
  'en',
  'zh',
  'th',
  'vi',
  'ko',
  'ja',
  'km',
  'fr',
  'es',
];

/**
 * The language the dialogue is translated into. The studio used to dub into
 * Khmer only; the viewer now chooses. There is no `auto` — a target must name
 * one language — and Khmer is the default so old jobs keep behaving the same.
 */
export type TargetLanguage = 'en' | 'zh' | 'th' | 'vi' | 'ko' | 'ja' | 'km' | 'fr' | 'es';

/** Any code the studio may send as a target; anything else is rejected. */
export const TARGET_LANGUAGES: TargetLanguage[] = [
  'km',
  'en',
  'zh',
  'th',
  'vi',
  'ko',
  'ja',
  'fr',
  'es',
];

/** The default target, and the value old jobs without the field fall back to. */
export const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'km';

/**
 * `sourceLanguage` is optional because jobs stored before the studio offered the
 * picker do not have it — those fall back to `auto`.
 */
export interface JobSettings {
  voice: 'auto' | 'male' | 'female';
  voiceStyle: 'natural' | 'calm' | 'energetic' | 'dramatic';
  backgroundMusic: 'keep' | 'reduce' | 'remove';
  subtitle: boolean;
  outputQuality: '720p' | '1080p' | 'original';
  translationStyle: 'natural' | 'formal';
  sourceLanguage?: SourceLanguage;
  /**
   * Optional because jobs stored before the picker existed do not have it —
   * those fall back to Khmer, which is what the pipeline always did.
   */
  targetLanguage?: TargetLanguage;
  /**
   * Brand glossary: names, brands and technical terms the translator must leave
   * alone. One entry per line — a bare term is kept verbatim in the Khmer line,
   * `term = translation` forces one exact Khmer rendering instead.
   */
  glossary?: string;
}

export interface VideoMetadata {
  duration: number; // in seconds
  width?: number;
  height?: number;
  format?: string;
  sizeBytes: number;
  videoCodec?: string;
  audioCodec?: string;
}

/** One stretch of the recording that is nothing but disturbance. */
export interface NoiseSpan {
  start: number;
  end: number;
  kind?: string;
  /** The model's own confidence, 0 to 1. */
  confidence?: number;
}

/** What the cleanup pass did, shown under the finished audio. */
export interface CleanupReport {
  model: string;
  keyLabel: string;
  chunks: number;
  chunksAnalysed: number;
  chunksFailed: number;
  spansFound: number;
  spansRemoved: number;
  removedSeconds: number;
  originalSeconds: number;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  /** Which pipeline ran: stem separation, or the Gemini voice cleanup. */
  mode?: 'separate' | 'clean';
  progress: number; // 0 to 100
  message: string; // User-facing status message (Khmer or English)
  khmerMessage?: string;
  inputFile: string;
  originalFilename: string;
  inputMimeType: string;
  metadata?: VideoMetadata;
  /** What was uploaded: a video carries a picture, an audio file does not. */
  inputKind?: 'video' | 'audio';
  /**
   * Optional because jobs recorded while the studio dubbed video carry the old
   * settings block and new separation jobs carry none — the separator never
   * asks what language to dub into.
   */
  settings?: JobSettings;
  /** The separated voice track: spoken dialogue and singing, without the music. */
  vocalsFile?: string;
  /** The separated music track: everything that is not a human voice. */
  musicFile?: string;
  /** The same two stems muxed back over the original picture, when a video was uploaded. */
  vocalsVideoFile?: string;
  musicVideoFile?: string;
  /** The cleaned voice from the Gemini cleanup, with the noise removed. */
  cleanFile?: string;
  /** The cleaned audio muxed over the original picture, for a video upload. */
  cleanVideoFile?: string;
  /** What the cleanup found and removed. */
  cleanup?: CleanupReport;
  segments?: DialogueSegment[];
  speakers?: SpeakerInfo[];
  outputFile?: string;
  /** Legacy subtitle-free twin from the old burn-in flow; new jobs only set `outputFile`. */
  outputFileClean?: string;
  outputSubtitlesSrt?: string;
  outputSubtitlesVtt?: string;
  /** Legacy mixed-audio WAV from before the single-MP4 release; new jobs leave it unset. */
  outputAudioFile?: string;
  warning?: string;
  error?: string;
  technicalError?: string;
  /** Set by the owner to stop a run that is still processing. */
  cancelRequested?: boolean;
  /** True when the run ended because it was cancelled, not because it failed. */
  cancelled?: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface SystemConfigStatus {
  audioSeparation: { configured: boolean; provider: string; model?: string; message?: string };
  storage: {
    configured: boolean;
    provider: string;
    bucket?: string;
    endpoint?: string;
    hasCredentials?: boolean;
    message?: string;
  };
  ffmpeg: { configured: boolean; version?: string };
  maxVideoSizeMb: number;
}
