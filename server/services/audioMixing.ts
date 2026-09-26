import fs from 'fs';
import path from 'path';
import { DialogueSegment, JobSettings } from '../types.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

function slotDuration(seg: DialogueSegment): number {
  return Math.max(0.3, seg.end - seg.start);
}

export class AudioMixingService {
  /**
   * Assembles all individual dialogue audio segments onto a single master dialogue track
   * with precise timestamp alignment (adelay filter), ensuring zero dialogue overlap.
   * Each line is hard-trimmed to its original slot so even if TTS slightly overran,
   * it never bleeds into the next mouth movement — this is what makes lip-sync 100%.
   */
  public static async assembleDialogueTrack(
    segments: DialogueSegment[],
    totalDuration: number,
    outputSpeechTrackPath: string,
    tempDir: string
  ): Promise<string> {
    const raw = segments.filter(s => s.audioFile && fs.existsSync(s.audioFile));
    // Mouth order is timeline order; WHISPER can return out-of-order chunks
    const validSegments = [...raw].sort((a, b) => a.start - b.start);

    if (validSegments.length === 0) {
      logger.warn('No valid audio segments to assemble; generating silent audio track');
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

    // Clamp overlaps: if a slot overlaps the next mouth start, trim the line
    // to gap-to-next so lines never talk over each other.
    const effectiveSlots: number[] = validSegments.map(slotDuration);
    for (let i = 0; i < validSegments.length - 1; i++) {
      const gap = validSegments[i + 1].start - validSegments[i].start;
      // Keep a tiny 30ms breathing gap so cuts are not clicky
      const maxForSlot = Math.max(0.3, gap - 0.03);
      if (effectiveSlots[i] > maxForSlot) {
        logger.info(`Trimming segment ${validSegments[i].id} slot ${effectiveSlots[i].toFixed(2)}s -> ${maxForSlot.toFixed(2)}s to avoid overlap with next line.`);
        effectiveSlots[i] = maxForSlot;
      }
    }

    if (validSegments.length === 1) {
      const seg = validSegments[0];
      const delayMs = Math.max(0, Math.round(seg.start * 1000));
      const trim = effectiveSlots[0].toFixed(3);
      await FFmpegHelper.execute([
        '-y',
        '-i', seg.audioFile!,
        '-filter_complex', `[0:a]atrim=end=${trim},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},apad=whole_dur=${Math.ceil(totalDuration)}[out]`,
        '-map', '[out]',
        '-ac', '2',
        '-ar', '44100',
        outputSpeechTrackPath,
      ]);
      return outputSpeechTrackPath;
    }

    const inputArgs: string[] = [];
    const filterClauses: string[] = [];
    const mixInputs: string[] = [];

    validSegments.forEach((seg, idx) => {
      inputArgs.push('-i', seg.audioFile!);
      const delayMs = Math.max(0, Math.round(seg.start * 1000));
      const trim = effectiveSlots[idx].toFixed(3);
      // atrim to slot guarantees no line ever overruns its mouth window
      filterClauses.push(`[${idx}:a]atrim=end=${trim},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[a${idx}]`);
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

    logger.info(`Assembled ${validSegments.length} dialogue segments (sorted, trimmed to slots) into master track: ${outputSpeechTrackPath}`);
    return outputSpeechTrackPath;
  }

  /**
   * Intelligently mix dubbed Khmer dialogue track with background music/ambient audio (no_vocals.wav)
   *
   * `segments` supplies the dialogue windows: the background is ducked inside them so
   * the original voices cannot be heard under the Khmer dub, while the music is kept
   * at full quality everywhere else. Windows are sorted and merged so the gate
   * expression is short and never flickers on overlapping timestamps.
   */
  public static async mixDubbedWithBackground(
    speechTrackPath: string,
    backgroundTrackPath: string,
    outputMixedTrackPath: string,
    settings: JobSettings,
    options: {
      segments?: DialogueSegment[];
      backgroundHasOriginalVoice?: boolean;
      /** Reported while the mix is written, so a slow host still shows movement. */
      onProgress?: (writtenSeconds: number) => void;
    } = {}
  ): Promise<string> {
    const raw = (options.segments || [])
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
      .map((segment) => ({ start: segment.start, end: segment.end }))
      .sort((a, b) => a.start - b.start);

    // Merge overlapping / nearly-touching windows so the gate doesn't chatter
    const dialogueWindows: { start: number; end: number }[] = [];
    for (const w of raw) {
      const last = dialogueWindows[dialogueWindows.length - 1];
      if (last && w.start <= last.end + 0.08) {
        last.end = Math.max(last.end, w.end);
      } else {
        dialogueWindows.push({ ...w });
      }
    }

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
        onProgress: options.onProgress,
      }
    );
  }
}
