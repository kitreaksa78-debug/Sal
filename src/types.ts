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
  start: number;
  end: number;
  text: string;
  khmer?: string;
  emotion?: string;
  audioDuration?: number;
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
