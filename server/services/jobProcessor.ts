import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { JobRecord, JobSettings, JobStatus, DialogueSegment } from '../types.js';
import { getDatabase } from './db.js';
import { getStorage } from './storage.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { getAudioSeparationProvider } from './audioSeparation.js';
import { getTranscriptionProvider } from './transcription.js';
import { SpeakerDetector } from './speakerDetection.js';
import { getTranslationService } from './translation.js';
import { getTTSProvider } from './tts.js';
import { AudioMixingService } from './audioMixing.js';
import { VideoRenderingService } from './videoRendering.js';
import { logger } from '../utils/logger.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

export const jobEvents = new EventEmitter();

// Khmer status messages matching pipeline steps
export const KHMER_STEP_MESSAGES: Record<JobStatus, string> = {
  queued: 'កំពុងស្ថិតក្នុងជួររង់ចាំ...',
  uploading: 'កំពុងផ្ទុកវីដេអូឡើង...',
  extracting_audio: 'កំពុងស្រង់សំឡេងចេញពីវីដេអូ...',
  separating_audio: 'កំពុងញែកសំឡេងមនុស្ស និងភ្លេងផ្ទៃខាងក្រោយ...',
  transcribing: 'កំពុងស្តាប់ និងបំប្លែងពាក្យសន្ទនា...',
  detecting_speakers: 'កំពុងកំណត់អត្តសញ្ញាណអ្នកនិយាយ...',
  translating: 'កំពុងវិភាគបរិបទ និងបកប្រែជាភាសាខ្មែរនិយាយបែបធម្មជាតិ...',
  generating_voice: 'កំពុងបង្កើតសំឡេងនិយាយខ្មែរតាមតួអង្គ...',
  syncing: 'កំពុងតម្រឹមចង្វាក់សំឡេងឱ្យត្រូវតាមពេលវេលាដើម...',
  mixing: 'កំពុងបញ្ចូលសំឡេងខ្មែរជាមួយភ្លេង និងសំឡេងផ្ទៃខាងក្រោយ...',
  rendering: 'កំពុង Render វីដេអូ MP4 ចុងក្រោយ (H.264/AAC)...',
  quality_check: 'កំពុងត្រួតពិនិត្យគុណភាពវីដេអូ...',
  completed: 'វីដេអូបកប្រែ និងបញ្ចូលសំឡេងរួចរាល់ជាស្ថាពរ!',
  failed: 'មានបញ្ហាក្នុងការដំណើរការ',
};

export const ENGLISH_STEP_MESSAGES: Record<JobStatus, string> = {
  queued: 'Job queued...',
  uploading: 'Uploading video...',
  extracting_audio: 'Extracting audio from video...',
  separating_audio: 'Separating human speech from music & background...',
  transcribing: 'Transcribing spoken dialogue...',
  detecting_speakers: 'Identifying speakers and vocal characteristics...',
  translating: 'Analyzing context & translating to natural spoken Khmer...',
  generating_voice: 'Synthesizing character-matched Khmer speech...',
  syncing: 'Synchronizing speech duration to original timestamps...',
  mixing: 'Mixing Khmer speech with preserved background music...',
  rendering: 'Rendering final H.264/AAC MP4 video...',
  quality_check: 'Performing automated quality checks...',
  completed: 'Khmer dubbed video completed successfully!',
  failed: 'Processing failed',
};

// Progress percentage mapping
const STATUS_PROGRESS: Record<JobStatus, number> = {
  queued: 5,
  uploading: 10,
  extracting_audio: 18,
  separating_audio: 28,
  transcribing: 40,
  detecting_speakers: 48,
  translating: 58,
  generating_voice: 70,
  syncing: 80,
  mixing: 88,
  rendering: 94,
  quality_check: 98,
  completed: 100,
  failed: 100,
};

export class JobProcessor {
  private static activeJobs = new Set<string>();

  /**
   * Update job status in database and broadcast via SSE
   */
  public static async updateJobState(
    jobId: string,
    status: JobStatus,
    customKhmerMsg?: string,
    extraUpdates: Partial<JobRecord> = {}
  ): Promise<JobRecord | null> {
    const db = getDatabase();
    const progress = STATUS_PROGRESS[status] ?? 50;
    const khmerMessage = customKhmerMsg || KHMER_STEP_MESSAGES[status] || status;
    const englishMessage = ENGLISH_STEP_MESSAGES[status] || status;

    const updated = await db.updateJob(jobId, {
      status,
      progress,
      message: englishMessage,
      khmerMessage,
      ...extraUpdates,
    });

    if (updated) {
      jobEvents.emit(`job:${jobId}`, updated);
      jobEvents.emit('job:updated', updated);
    }

    return updated;
  }

  /**
   * The language the studio picked for this video, or undefined when the speech-to-text
   * model should work it out itself. Jobs saved before the picker existed have no value,
   * which also means "detect it".
   */
  private static getSourceLanguage(settings?: JobSettings): string | undefined {
    const code = settings?.sourceLanguage;
    return code && code !== 'auto' ? code : undefined;
  }

  /**
   * Main asynchronous pipeline processor
   */
  public static async processJob(jobId: string): Promise<void> {
    if (this.activeJobs.has(jobId)) {
      logger.warn(`Job ${jobId} is already actively processing`);
      return;
    }

    this.activeJobs.add(jobId);
    const db = getDatabase();
    const storage = getStorage();
    const job = await db.getJob(jobId);

    if (!job) {
      logger.error(`Job ${jobId} not found in database`);
      this.activeJobs.delete(jobId);
      return;
    }

    const jobTempDir = path.join(process.cwd(), 'data', 'processing', jobId);
    if (!fs.existsSync(jobTempDir)) {
      fs.mkdirSync(jobTempDir, { recursive: true });
    }

    // Degraded-but-usable runs collect their reasons here instead of failing.
    const warnings: string[] = [];
    const addWarning = async (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
      await db.updateJob(jobId, { warning: warnings.join('\n\n') });
    };

    try {
      logger.info(`Starting asynchronous processing for job ${jobId}`);

      // STEP 1: VALIDATE VIDEO
      await this.updateJobState(jobId, 'extracting_audio');

      const videoFilePath = job.inputFile;
      if (!fs.existsSync(videoFilePath)) {
        throw new Error('Video source file not found on disk.');
      }

      // Probe video metadata
      const meta = await FFmpegHelper.probeVideo(videoFilePath);
      if (!meta.duration || meta.duration <= 0.1) {
        throw new Error('Video file has invalid duration or cannot be decoded.');
      }

      await db.updateJob(jobId, { metadata: meta });

      // STEP 2: EXTRACT AUDIO
      const rawAudioPath = path.join(jobTempDir, 'extracted_audio.wav');
      await FFmpegHelper.extractAudio(videoFilePath, rawAudioPath, 44100);

      // STEP 3: VOICE / MUSIC SEPARATION
      await this.updateJobState(jobId, 'separating_audio');
      const separationProvider = getAudioSeparationProvider();
      const separationResult = await separationProvider.separate(rawAudioPath, jobTempDir);

      const vocalsTrack = separationResult.vocalsPath;
      const noVocalsTrack = separationResult.noVocalsPath; // music/background track

      // STEP 4: SPEECH-TO-TEXT & DETECTION
      await this.updateJobState(jobId, 'transcribing');
      const transcriptionProvider = getTranscriptionProvider();

      // Naming the spoken language up front is what keeps Whisper from guessing
      // wrong on mixed-language audio; `auto` leaves the guess to the model.
      const sourceLanguage = this.getSourceLanguage(job.settings);
      if (sourceLanguage) {
        logger.info(`Job ${jobId}: speech-to-text is pinned to "${sourceLanguage}".`);
      }

      // Transcribe dialogue with timestamps
      let dialogueSegments = await transcriptionProvider.transcribe(vocalsTrack, meta.duration, {
        language: sourceLanguage,
      });

      // If no speech was detected, create fallback placeholder segment or notify
      if (dialogueSegments.length === 0) {
        logger.info(`No distinct speech detected in job ${jobId}. Checking full audio track...`);
        // Retry transcription on raw audio in case vocals filter was too aggressive
        try {
          dialogueSegments = await transcriptionProvider.transcribe(rawAudioPath, meta.duration, {
            language: sourceLanguage,
          });
        } catch {}
      }

      if (dialogueSegments.length === 0) {
        logger.warn(`No linguistic dialogue detected in ${jobId}`);
        // Create an informational segment
        dialogueSegments = [
          {
            id: 'seg_1',
            speaker: 'speaker_1',
            start: 0.5,
            end: Math.min(meta.duration, 3.5),
            text: 'Audio track ready for natural Khmer dubbing',
            khmer: 'វីដេអូរួចរាល់សម្រាប់ការបញ្ចូលសំឡេងខ្មែរ',
          },
        ];
      }

      // STEP 5: SPEAKER IDENTIFICATION
      await this.updateJobState(jobId, 'detecting_speakers');
      const speakerProfiles = SpeakerDetector.identifySpeakers(dialogueSegments);
      await db.updateJob(jobId, { speakers: speakerProfiles });

      // STEP 6: CONTEXT ANALYSIS & KHMER TRANSLATION
      await this.updateJobState(jobId, 'translating');
      const translationService = getTranslationService();

      try {
        // The translator reports progress block by block so a long transcript
        // shows movement instead of sitting on one percentage.
        const outcome = await translationService.translateDialogue(
          dialogueSegments,
          job.settings,
          async (completedLines, totalLines) => {
            const pct = 58 + Math.round((completedLines / Math.max(1, totalLines)) * 10);
            await this.updateJobState(
              jobId,
              'translating',
              `កំពុងបកប្រែជាភាសាខ្មែរ ${completedLines}/${totalLines} បន្ទាត់...`,
              { progress: Math.min(pct, 68) }
            );
          }
        );

        dialogueSegments = outcome.segments;
        for (const warning of outcome.warnings) {
          await addWarning(warning);
        }
      } catch (translationErr: any) {
        // A translator hiccup should not discard a good transcription: keep the
        // original lines and tell the user the subtitles stay in the source language.
        logger.warn(`Translation failed for job ${jobId}, keeping original dialogue:`, translationErr);
        await addWarning(
          `ការបកប្រែជាខ្មែរមិនបានសម្រេចទេ ដូច្នេះអក្សររត់នឹងនៅជាភាសាដើម។ (Translation failed: ${translationErr?.message ?? 'unknown error'}. Subtitles keep the original language.)`
        );
      }

      await db.saveSegments(jobId, dialogueSegments);

      // STEP 7: KHMER TTS SPEECH SYNTHESIS & TIMING MATCH
      await this.updateJobState(jobId, 'generating_voice');
      const ttsProvider = getTTSProvider();

      // Voice-over needs a Khmer-capable TTS engine. When none is configured we
      // still deliver the Khmer translation as subtitles instead of failing the
      // whole job, and we keep the original audio so nobody ends up muted.
      const ttsAvailable = ttsProvider.isConfigured();

      const segmentsDir = path.join(jobTempDir, 'tts_segments');
      if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir, { recursive: true });

      if (ttsAvailable) {
        // Lines are independent, so synthesize several at once instead of the
        // old one-at-a-time loop; a 60-line video used to spend a full minute here.
        // Edge is a keyless public endpoint that serves many parallel lines, so it
        // runs wider than the metered providers (Gemini TTS has a real quota).
        const defaultTtsConcurrency = ttsProvider.name === 'edge' ? 6 : 3;
        const ttsConcurrency = Math.max(
          1,
          Number(process.env.TTS_CONCURRENCY) || defaultTtsConcurrency
        );
        let voicedSoFar = 0;

        await mapWithConcurrency(dialogueSegments, ttsConcurrency, async (seg, i) => {
          const segOutPath = path.join(segmentsDir, `segment_${i + 1}.wav`);
          const originalDuration = Math.max(0.5, seg.end - seg.start);

          // Determine voice gender
          let gender: 'male' | 'female' | 'neutral' = seg.speakerGender || 'male';
          if (job.settings.voice === 'male') gender = 'male';
          if (job.settings.voice === 'female') gender = 'female';

          const khmerText = (seg.khmer || seg.text).trim();

          try {
            const ttsResult = await ttsProvider.synthesizeSpeech(khmerText, segOutPath, {
              gender,
              emotion: seg.emotion,
              voiceStyle: job.settings.voiceStyle,
              targetDuration: originalDuration,
            });

            seg.audioFile = ttsResult.audioPath;
            seg.audioDuration = ttsResult.duration;
          } catch (ttsErr) {
            logger.warn(`TTS synthesis failed for segment ${seg.id}:`, ttsErr);
          }

          voicedSoFar++;
          const pct = 70 + Math.round((voicedSoFar / dialogueSegments.length) * 9);
          await this.updateJobState(
            jobId,
            'generating_voice',
            `កំពុងបង្កើតសំឡេងខ្មែរ ${voicedSoFar}/${dialogueSegments.length} បន្ទាត់...`,
            { progress: Math.min(pct, 79) }
          );
        });
      }

      await db.saveSegments(jobId, dialogueSegments);

      // Voice-over only counts as usable when at least one line produced audio.
      // Otherwise the mix would strip the dialogue out and ship a silent cast.
      const voicedSegments = dialogueSegments.filter((seg) => seg.audioFile);
      const canDub = ttsAvailable && voicedSegments.length > 0;

      if (!ttsAvailable) {
        logger.warn(
          `No Khmer TTS provider configured for job ${jobId}; producing a Khmer-subtitled release.`
        );
        await addWarning(
          'សំឡេងខ្មែរ (Khmer voice-over) មិនទាន់អាចបង្កើតបានទេ។ វីដេអូនឹងរក្សាសំឡេងដើម ហើយអក្សររត់ខ្មែរត្រូវបានបង្កើតរួចរាល់។ (Khmer voice-over unavailable: original audio kept, Khmer subtitles still generated.)'
        );
      } else if (!canDub) {
        logger.warn(
          `Khmer voice generation failed for every line in job ${jobId}; keeping original audio.`
        );
        await addWarning(
          'ការបង្កើតសំឡេងខ្មែរបរាជ័យសម្រាប់គ្រប់បន្ទាត់។ វីដេអូនឹងរក្សាសំឡេងដើម និងអក្សររត់ខ្មែរ។ (Khmer voice generation failed for every line; original audio kept, Khmer subtitles still generated.)'
        );
      } else if (voicedSegments.length < dialogueSegments.length) {
        logger.warn(
          `${dialogueSegments.length - voicedSegments.length} of ${dialogueSegments.length} lines could not be voiced in job ${jobId}.`
        );
        await addWarning(
          `សំឡេងខ្មែរបង្កើតបានតែ ${voicedSegments.length}/${dialogueSegments.length} បន្ទាត់។ បន្ទាត់ដែលនៅសល់រក្សាសំឡេងដើម។ (Khmer voice generated for ${voicedSegments.length}/${dialogueSegments.length} lines; the rest keep the original audio.)`
        );
      }

      const finalMixedAudioTrack = path.join(jobTempDir, 'final_mixed_audio.wav');

      if (canDub) {
        // STEP 8: SYNC & ASSEMBLE DIALOGUE TRACK
        await this.updateJobState(jobId, 'syncing');
        const masterSpeechTrack = path.join(jobTempDir, 'master_khmer_speech.wav');
        await AudioMixingService.assembleDialogueTrack(
          dialogueSegments,
          meta.duration,
          masterSpeechTrack,
          jobTempDir
        );

        // STEP 9: AUDIO MIXING (Dubbed Speech + Kept Music/Background)
        await this.updateJobState(jobId, 'mixing');
        await AudioMixingService.mixDubbedWithBackground(
          masterSpeechTrack,
          noVocalsTrack,
          finalMixedAudioTrack,
          job.settings,
          {
            segments: dialogueSegments,
            backgroundHasOriginalVoice: separationResult.backgroundHasOriginalVoice,
          }
        );
      } else {
        // No usable Khmer voice track: carry the untouched original audio through
        // so the released video keeps its dialogue and only adds Khmer subtitles.
        await this.updateJobState(jobId, 'mixing', 'កំពុងរក្សាសំឡេងដើម និងបន្ថែមអក្សររត់ខ្មែរ...');
        fs.copyFileSync(rawAudioPath, finalMixedAudioTrack);
      }

      // Save mixed audio file to outputs
      const audioOutputFilename = `khmer-audio-${jobId}.wav`;
      const savedAudioPath = await storage.saveFile('outputs', audioOutputFilename, finalMixedAudioTrack);

      // STEP 10: RENDER FINAL MP4 VIDEO (H.264 / AAC)
      await this.updateJobState(jobId, 'rendering');
      const tempFinalMp4 = path.join(jobTempDir, `khmer-dubbed-${jobId}.mp4`);
      await VideoRenderingService.renderMp4(
        videoFilePath,
        finalMixedAudioTrack,
        tempFinalMp4,
        job.settings
      );

      // Generate Subtitles (SRT & VTT)
      const srtContent = VideoRenderingService.generateSrt(dialogueSegments);
      const vttContent = VideoRenderingService.generateVtt(dialogueSegments);
      const srtFilename = `subtitles-${jobId}.srt`;
      const vttFilename = `subtitles-${jobId}.vtt`;

      const savedSrtPath = await storage.saveFile('outputs', srtFilename, Buffer.from(srtContent, 'utf8'));
      const savedVttPath = await storage.saveFile('outputs', vttFilename, Buffer.from(vttContent, 'utf8'));

      // STEP 11: QUALITY CHECK
      await this.updateJobState(jobId, 'quality_check');
      const qualityResult = await FFmpegHelper.verifyOutputQuality(tempFinalMp4);
      if (!qualityResult.valid) {
        throw new Error(`Quality verification failed: ${qualityResult.reason}`);
      }

      // Save final video to outputs storage
      const finalMp4Filename = `khmer-dubbed-${jobId}.mp4`;
      const savedMp4Path = await storage.saveFile('outputs', finalMp4Filename, tempFinalMp4);

      // STEP 12: COMPLETED
      await this.updateJobState(jobId, 'completed', KHMER_STEP_MESSAGES.completed, {
        outputFile: savedMp4Path,
        outputAudioFile: savedAudioPath,
        outputSubtitlesSrt: savedSrtPath,
        outputSubtitlesVtt: savedVttPath,
        completedAt: new Date().toISOString(),
      });

      logger.info(`Job ${jobId} successfully completed! Output: ${savedMp4Path}`);

      // Clean up temporary processing folder
      await storage.cleanProcessingDir(jobId);
    } catch (err: any) {
      logger.error(`Job ${jobId} processing failed with error:`, err);

      // Friendly Khmer error messages
      let friendlyKhmer = 'មិនអាចដំណើរការសំឡេងក្នុងវីដេអូនេះបានទេ។ សូមសាកល្បងវីដេអូមួយផ្សេងទៀត។';
      const errMsg = err?.message || '';

      if (errMsg.includes('ញែកភ្លេងដោយ Demucs') || errMsg.includes('ម៉ាស៊ីនញែកភ្លេង')) {
        // Stem separation has no substitute, so the reason it failed is the whole
        // story: show it instead of the generic "try another video" line.
        friendlyKhmer = errMsg;
      } else if (/\(429\)|rate limit|too many requests/i.test(errMsg)) {
        friendlyKhmer =
          'អត្រាប្រើប្រាស់ AI ពេញ (rate limit)។ សូមរង់ចាំបន្តិច រួចសាកល្បងម្តងទៀត ឬបន្ថែម Groq key ផ្សេងទៀត។ (AI rate limit reached: wait a moment or add another Groq key.)';
      } else if (errMsg.includes('is not configured') || errMsg.includes('No translation provider')) {
        friendlyKhmer =
          'មិនទាន់បានកំណត់ API key សម្រាប់ AI ទេ។ សូមបញ្ចូល GROQ_API_KEY ក្នុង Settings → Environment។ (No AI API key configured.)';
      } else if (/\(401\)|invalid api key/i.test(errMsg)) {
        friendlyKhmer =
          'API key មិនត្រឹមត្រូវ ឬត្រូវបានលុបចោល។ សូមពិនិត្យ GROQ_API_KEY ម្តងទៀត។ (Invalid or revoked API key.)';
      } else if (/\(402\)|\(403\)|quota|billing/i.test(errMsg)) {
        friendlyKhmer =
          'គណនី AI គ្មានសិទ្ធិ ឬអស់កូតា។ សូមពិនិត្យគណនី Groq របស់អ្នក។ (AI account permission or quota problem.)';
      } else if (errMsg.includes('API key') || errMsg.includes('Gemini')) {
        friendlyKhmer = 'សេវាកម្ម AI Gemini មិនទាន់បានកំណត់រចនាសម្ព័ន្ធ ឬមានបញ្ហាតភ្ជាប់ទេ។';
      } else if (errMsg.includes('TTS') || errMsg.includes('synthesize')) {
        friendlyKhmer = 'មិនអាចបង្កើតសំឡេងខ្មែរបានទេ សូមពិនិត្យការកំណត់សំឡេង។';
      } else if (errMsg.includes('Quality verification')) {
        friendlyKhmer = 'ការត្រួតពិនិត្យគុណភាពវីដេអូមិនបានសម្រេច។ សូមសាកល្បងជាមួយវីដេអូផ្សេងទៀត។';
      }

      await this.updateJobState(jobId, 'failed', friendlyKhmer, {
        error: friendlyKhmer,
        technicalError: errMsg,
        completedAt: new Date().toISOString(),
      });

      // Cleanup
      try {
        await storage.cleanProcessingDir(jobId);
      } catch {}
    } finally {
      this.activeJobs.delete(jobId);
    }
  }
}
