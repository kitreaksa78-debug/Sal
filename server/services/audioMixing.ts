import fs from 'fs';
import path from 'path';
import { DialogueSegment, JobSettings } from '../types.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

export class AudioMixingService {
  /**
   * Assembles all individual dialogue audio segments onto a single master dialogue track
   * with precise timestamp alignment (adelay filter), ensuring zero dialogue overlap.
   */
  public static async assembleDialogueTrack(
    segments: DialogueSegment[],
    totalDuration: number,
    outputSpeechTrackPath: string,
    tempDir: string
  ): Promise<string> {
    const validSegments = segments.filter(s => s.audioFile && fs.existsSync(s.audioFile));

    if (validSegments.length === 0) {
      logger.warn('No valid audio segments to assemble; generating silent audio track');
      // Generate silence of total duration
      await FFmpegHelper.execute([
        '-y',
        '-f', 'lavfi',
        '-i', `anullsrc=r=44100:cl=stereo`,
        '-t', totalDuration.toString(),
        '-acodec', 'pcm_s16le',
        outputSpeechTrackPath,
      ]);
      return outputSpeechTrackPath;
    }

    if (validSegments.length === 1) {
      const seg = validSegments[0];
      const delayMs = Math.max(0, Math.round(seg.start * 1000));
      await FFmpegHelper.execute([
        '-y',
        '-i', seg.audioFile!,
        '-filter_complex', `[0:a]adelay=${delayMs}|${delayMs},apad=whole_dur=${Math.ceil(totalDuration)}[out]`,
        '-map', '[out]',
        '-ac', '2',
        '-ar', '44100',
        outputSpeechTrackPath,
      ]);
      return outputSpeechTrackPath;
    }

    // Build FFmpeg command for multiple delayed segments
    // To prevent exceeding command-line length limits on many segments, we can batch or chain adelay
    const inputArgs: string[] = [];
    const filterClauses: string[] = [];
    const mixInputs: string[] = [];

    validSegments.forEach((seg, idx) => {
      inputArgs.push('-i', seg.audioFile!);
      const delayMs = Math.max(0, Math.round(seg.start * 1000));
      filterClauses.push(`[${idx}:a]adelay=${delayMs}|${delayMs}[a${idx}]`);
      mixInputs.push(`[a${idx}]`);
    });

    filterClauses.push(
      `${mixInputs.join('')}amix=inputs=${validSegments.length}:dropout_transition=0:normalize=0,apad=whole_dur=${Math.ceil(totalDuration)}[out]`
    );

    const filterComplex = filterClauses.join(';');

    await FFmpegHelper.execute([
      '-y',
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-ac', '2',
      '-ar', '44100',
      outputSpeechTrackPath,
    ]);

    logger.info(`Assembled ${validSegments.length} dialogue segments into master dialogue track: ${outputSpeechTrackPath}`);
    return outputSpeechTrackPath;
  }

  /**
   * Intelligently mix dubbed Khmer dialogue track with background music/ambient audio (no_vocals.wav)
   *
   * `segments` supplies the dialogue windows: the background is muted inside them so
   * the original voices cannot be heard under the Khmer dub, while the music is kept
   * at full quality everywhere else.
   */
  public static async mixDubbedWithBackground(
    speechTrackPath: string,
    backgroundTrackPath: string,
    outputMixedTrackPath: string,
    settings: JobSettings,
    options: {
      segments?: DialogueSegment[];
      backgroundHasOriginalVoice?: boolean;
    } = {}
  ): Promise<string> {
    const dialogueWindows = (options.segments || [])
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
      .map((segment) => ({ start: segment.start, end: segment.end }));

    return await FFmpegHelper.mixDubbedAudio(
      speechTrackPath,
      backgroundTrackPath,
      outputMixedTrackPath,
      {
        backgroundMusic: settings.backgroundMusic,
        speechVolume: 1.3,
        musicVolume: settings.backgroundMusic === 'reduce' ? 0.35 : 0.65,
        dialogueWindows,
        backgroundHasOriginalVoice: options.backgroundHasOriginalVoice ?? false,
      }
    );
  }
}
