/**
 * Every state a run can be in.
 *
 * The site separates voice from music and reports `queued → extracting_audio →
 * separating_audio → mixing → completed`, but the dubbing-era statuses stay in
 * this union because jobs recorded while the studio translated video are still
 * stored and still render on screen — a status a saved job carries must never
 * fall outside the type.
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

export interface VideoMetadata {
  duration: number;
  width?: number;
  height?: number;
  format?: string;
  sizeBytes: number;
  videoCodec?: string;
  audioCodec?: string;
}

/** What the Gemini cleanup pass did, as the result screen reports it. */
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

/** What the Khmer version did, as the result screen reports it. */
export interface KhmerDubReport {
  model: string;
  keyLabel: string;
  voice: 'female' | 'male';
  voiceName: string;
  /** Which speech engine sang it, when the server reports one. */
  engine?: string;
  lines: number;
  voiced: number;
  chunks: number;
  chunksFailed: number;
  spokenSeconds: number;
  originalSeconds: number;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  /**
   * Which pipeline ran: stem separation, the Gemini voice cleanup, or the Khmer
   * version built from a finished separation.
   */
  mode?: 'separate' | 'clean' | 'dub';
  progress: number;
  message: string;
  khmerMessage?: string;
  inputFile: string;
  originalFilename: string;
  inputMimeType: string;
  metadata?: VideoMetadata;
  /** What was uploaded: a video carries a picture, an audio file does not. */
  inputKind?: 'video' | 'audio';
  /** The separated voice track: spoken dialogue and singing, without the music. */
  vocalsFile?: string;
  /** The separated music track: everything that is not a human voice. */
  musicFile?: string;
  /** The same two stems muxed back over the original picture, for a video upload. */
  vocalsVideoFile?: string;
  musicVideoFile?: string;
  /** The cleaned voice from the Gemini cleanup, with the noise removed. */
  cleanFile?: string;
  /** The cleaned audio muxed over the original picture, for a video upload. */
  cleanVideoFile?: string;
  cleanup?: CleanupReport;
  /** The Khmer version: the separated music with the translated voice over it. */
  khmerFile?: string;
  /** The Khmer words alone, without the music — the input a voice clone needs. */
  khmerSpeechFile?: string;
  /** The same Khmer song over the original picture, for a video upload. */
  khmerVideoFile?: string;
  /** The Khmer voice chosen for this version. */
  khmerVoice?: 'female' | 'male';
  /** What the Khmer version did. */
  khmer?: KhmerDubReport;
  /** The finished separation this Khmer version was built from. */
  sourceJobId?: string;
  /** The translated lines, when the job produced them. */
  segments?: { id: string; speaker: string; start: number; end: number; text: string; khmer?: string }[];
  warning?: string;
  error?: string;
  technicalError?: string;
  /** The studio asked the server to stop this run. */
  cancelRequested?: boolean;
  /** The run ended because it was cancelled, not because it failed. */
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
  /** The upload ceiling, in megabytes. */
  maxVideoSizeMb: number;
}
