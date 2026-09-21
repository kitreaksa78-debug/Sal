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
  smartVoice: boolean;
  sourceLanguage?: SourceLanguage;
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
  /** Google account id ("sub") of the signed-in user who uploaded this video. */
  ownerId?: string;
  ownerEmail?: string;
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

/**
 * A signed-in browser. The token is minted when Google sign-in succeeds and is
 * sent back on every API call, which is what keeps one account's job history and
 * usage apart from another's.
 */
export interface SessionRecord {
  token: string;
  userId: string;
  email: string;
  createdAt: string;
  lastSeenAt: string;
}

/** How much of the free daily allowance one account has used. */
export interface UsageRecord {
  /** YYYY-MM-DD — a new day starts a fresh count. */
  date: string;
  count: number;
  totalDuration: number;
}

/**
 * An account created by signing in with Google. Stored next to the job history
 * so the user list survives the ephemeral restarts of free hosts.
 */
export interface UserRecord {
  /** Google account id ("sub") — stable for the life of the account. */
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
  /** How many times this account has signed in. */
  logins: number;
  /** First and latest sign-in, so the list can show new vs returning users. */
  createdAt: string;
  lastLoginAt: string;
}

/** The verified Google profile the server received for a sign-in. */
export interface GoogleProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
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
