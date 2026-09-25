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

/**
 * The language spoken in the video. Whisper guesses the language per segment when
 * this is `auto`, which is where most transcription mistakes come from — naming the
 * language is the single biggest accuracy win for mixed-language libraries.
 */
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

export interface SourceLanguageOption {
  code: SourceLanguage;
  label: string;
}

export const SOURCE_LANGUAGES: SourceLanguageOption[] = [
  { code: 'auto', label: 'រកឃើញដោយស្វ័យប្រវត្តិ (Auto detect)' },
  { code: 'en', label: 'អង់គ្លេស (English)' },
  { code: 'zh', label: 'ចិន (Mandarin)' },
  { code: 'th', label: 'ថៃ (Thai)' },
  { code: 'vi', label: 'វៀតណាម (Vietnamese)' },
  { code: 'ko', label: 'កូរ៉េ (Korean)' },
  { code: 'ja', label: 'ជប៉ុន (Japanese)' },
  { code: 'km', label: 'ខ្មែរ (Khmer)' },
  { code: 'fr', label: 'បារាំង (French)' },
  { code: 'es', label: 'អេស្ប៉ាញ (Spanish)' },
];

export interface JobSettings {
  voice: 'auto' | 'male' | 'female';
  voiceStyle: 'natural' | 'calm' | 'energetic' | 'dramatic';
  backgroundMusic: 'keep' | 'reduce' | 'remove';
  subtitle: boolean;
  outputQuality: '720p' | '1080p' | 'original';
  translationStyle: 'natural' | 'formal';
  smartVoice: boolean;
  sourceLanguage: SourceLanguage;
  /**
   * Brand glossary: names, brands and technical terms the translator must leave
   * alone. One entry per line — a bare term is kept verbatim in the Khmer line,
   * `term = translation` forces one exact Khmer rendering instead.
   */
  glossary?: string;
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
  /** `keys`/`models` describe the free-tier rotation the translator walks. */
  gemini: { configured: boolean; model: string; keys?: number; models?: string[] };
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
