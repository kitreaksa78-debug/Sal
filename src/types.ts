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

export interface JobRecord {
  id: string;
  status: JobStatus;
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
