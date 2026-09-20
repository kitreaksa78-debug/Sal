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

export interface DialogueSegment {
  id: string;
  speaker: string;
  speakerGender?: 'male' | 'female' | 'neutral';
  start: number; // in seconds
  end: number;   // in seconds
  text: string;  // original text
  khmer?: string; // translated natural Khmer text
  emotion?: string; // e.g. neutral, energetic, calm, dramatic
  audioDuration?: number; // generated audio duration in seconds
  audioFile?: string; // path to synthesized segment audio
}

export interface SpeakerInfo {
  speakerId: string;
  gender: 'male' | 'female' | 'neutral';
  segments: DialogueSegment[];
}

export interface JobSettings {
  voice: 'auto' | 'male' | 'female';
  voiceStyle: 'natural' | 'calm' | 'energetic' | 'dramatic';
  backgroundMusic: 'keep' | 'reduce' | 'remove';
  subtitle: boolean;
  outputQuality: '720p' | '1080p' | 'original';
  translationStyle: 'natural' | 'formal';
  smartVoice: boolean;
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

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: number; // 0 to 100
  message: string; // User-facing status message (Khmer or English)
  khmerMessage?: string;
  inputFile: string;
  originalFilename: string;
  inputMimeType: string;
  metadata?: VideoMetadata;
  settings: JobSettings;
  segments?: DialogueSegment[];
  speakers?: SpeakerInfo[];
  outputFile?: string;
  outputSubtitlesSrt?: string;
  outputSubtitlesVtt?: string;
  outputAudioFile?: string;
  warning?: string;
  error?: string;
  technicalError?: string;
  createdAt: string;
  completedAt?: string;
}

export type ContactPlan = 'free' | 'pro';

/**
 * A visitor who contacted us from the welcome screen. Stored next to the job
 * history so the list survives the ephemeral restarts of free hosts.
 */
export interface ContactRecord {
  id: string;
  name: string;
  email: string;
  message: string;
  plan: ContactPlan;
  /** Where the record came from, e.g. "welcome". */
  source: string;
  /** Random id kept in the visitor's browser so repeat visits are recognisable. */
  deviceId: string;
  /** How many times this email has written to us. */
  times: number;
  createdAt: string;
  updatedAt: string;
}

/** What the client sends; the server fills in the id and the timestamps. */
export interface NewContact {
  name: string;
  email: string;
  message?: string;
  plan?: ContactPlan;
  source?: string;
  deviceId?: string;
}

export interface SystemConfigStatus {
  gemini: { configured: boolean; model: string };
  translation: { configured: boolean; provider: string; model: string; fallbackModels?: string[] };
  stt: { configured: boolean; provider: string; model: string };
  tts: { configured: boolean; provider: string; model: string };
  audioSeparation: { configured: boolean; provider: string };
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
  videoSegmentSeconds: number;
}
