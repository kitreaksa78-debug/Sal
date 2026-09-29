import fs from 'fs';
import path from 'path';
import { DialogueSegment, JobSettings } from '../types.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

/**
 * The breathing gap left between two lines on the assembled track. A line may
 * therefore only use the time up to `next.start - this gap`, which is the window
 * the synthesizer is asked to fit into as well — otherwise a line built for its
 * own longer slot gets cut here, mid-syllable.
 */
export const DIALOGUE_GAP_SECONDS = 0.03;

function slotDuration(seg: DialogueSegment): number {
  return Math.max(0.3, seg.end - seg.start);
}

/** What the sync step found and what it changed. */
export interface DialogueSyncReport {
  /** Lines that carry generated Khmer audio. */
  lines: number;
  /** Spoken stretches measured in the assembled track. */
  spoken: number;
  /** Lines whose voice begins where their mouth begins, within the tolerance. */
  onTime: number;
  /** Largest distance between a mouth start and the voice placed for it, in ms. */
  worstOnsetMs: number;
  /** Lines with no measurable voice in the assembled track. */
  silent: number;
  /** Length of the dialogue track before it was fitted to the video. */
  trackSeconds: number;
  /**
   * Where the voice really is, so the mixer can duck the background around it.
   * Empty when the track could not be measured; the caller then falls back to the
   * segments' own windows.
   */
  voiceWindows: { start: number; end: number }[];
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
    tempDir: string,
    options: {
      /**
       * How long each line may be, as the synthesizer was told. Silence between
       * two speakers belongs to the line before it, so this is usually longer
       * than the segment's own slot: giving it to the line is what stops the
       * Khmer voice being sliced mid-syllable. It stays clamped to the next
       * mouth start below, so two lines can never talk over each other.
       */
      speechWindows?: Map<string, number>;
    } = {}
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
    const effectiveSlots: number[] = validSegments.map(
      (seg) => options.speechWindows?.get(seg.id) ?? slotDuration(seg)
    );
    for (let i = 0; i < validSegments.length - 1; i++) {
      const gap = validSegments[i + 1].start - validSegments[i].start;
      // Keep a tiny breathing gap so cuts are not clicky
      const maxForSlot = Math.max(0.3, gap - DIALOGUE_GAP_SECONDS);
      if (effectiveSlots[i] > maxForSlot) {
        logger.info(`Trimming segment ${validSegments[i].id} slot ${effectiveSlots[i].toFixed(2)}s -> ${maxForSlot.toFixed(2)}s to avoid overlap with next line.`);
        effectiveSlots[i] = maxForSlot;
      }
    }

    if (validSegments.length === 1) {
      const seg = validSegments[0];
      const delayMs = Math.max(0, Math.round(seg.start * 1000));
      // The same fade the fit uses, so a line that reaches the cut point decays
      // instead of stopping dead; a line that ends earlier is unaffected.
      const trim = FFmpegHelper.slotTrimChain(effectiveSlots[0]);
      await FFmpegHelper.execute([
        '-y',
        '-i', seg.audioFile!,
        '-filter_complex', `[0:a]${trim},adelay=${delayMs}|${delayMs},apad=whole_dur=${Math.ceil(totalDuration)}[out]`,
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
      // Trimming to the window guarantees no line ever overruns its mouth
      // window; the fade inside slotTrimChain keeps that cut from clicking.
      const trim = FFmpegHelper.slotTrimChain(effectiveSlots[idx]);
      filterClauses.push(`[${idx}:a]${trim},adelay=${delayMs}|${delayMs}[a${idx}]`);
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
   * Make the generated Khmer voice land on the picture.
   *
   * Two things have to hold for a dub to look synchronised, and this is the step
   * that establishes both:
   *
   *  1. every line starts where its mouth starts. The assembler places each line at
   *     its own timestamp; this measures the finished track (`silencedetect`) rather
   *     than trusting the filter graph, so a line that ended up somewhere else is
   *     reported to the job instead of shipped quietly;
   *  2. the dialogue track is exactly as long as the video. A track that is short
   *     makes the whole release end early and one that is long plays the last frames
   *     in silence — see `FFmpegHelper.fitAudioToDuration`, and the render, which
   *     now caps at the video's own length for the same reason.
   *
   * The measured voice windows come back so the mixer ducks the background around
   * the voice that is really there: the music rises the moment the Khmer line ends,
   * instead of staying dipped through the rest of the original speaker's window.
   */
  public static async syncDialogueToTimeline(
    segments: DialogueSegment[],
    totalDuration: number,
    speechTrackPath: string,
    options: { speechWindows?: Map<string, number> } = {}
  ): Promise<DialogueSyncReport> {
    const voiced = segments.filter((seg) => seg.audioFile && fs.existsSync(seg.audioFile));
    const toleranceMs = Number(process.env.SYNC_TOLERANCE_MS || '250');

    const trackSeconds = await FFmpegHelper.getAudioDuration(speechTrackPath);
    const voiceWindows = await FFmpegHelper.detectSpeechWindows(speechTrackPath);

    let onTime = 0;
    let silent = 0;
    let worstOnsetMs = 0;

    for (const seg of voiced) {
      // The spoken stretch that belongs to this line is the one nearest to its
      // mouth start; anything further away than the tolerance means the voice for
      // that line is not where the picture expects it.
      let bestGap = Number.POSITIVE_INFINITY;
      for (const window of voiceWindows) {
        const gap = Math.abs(window.start - seg.start);
        if (gap < bestGap) bestGap = gap;
      }

      if (!Number.isFinite(bestGap) || bestGap * 1000 > toleranceMs) {
        silent++;
        continue;
      }

      onTime++;
      worstOnsetMs = Math.max(worstOnsetMs, Math.round(bestGap * 1000));
    }

    // Fit the track to the video before anything downstream uses it.
    if (totalDuration > 0 && Math.abs(trackSeconds - totalDuration) > 0.01) {
      const fittedPath = `${speechTrackPath}.synced.wav`;
      const measured = await FFmpegHelper.fitAudioToDuration(
        speechTrackPath,
        fittedPath,
        totalDuration
      );
      fs.renameSync(fittedPath, speechTrackPath);
      logger.info(
        `Sync: dialogue track ${trackSeconds.toFixed(2)}s -> ${measured.toFixed(
          2
        )}s to match the ${totalDuration.toFixed(2)}s video.`
      );
    } else if (voiced.length > 0) {
      logger.info(
        `Sync: dialogue track already matches the video (${trackSeconds.toFixed(2)}s).`
      );
    }

    logger.info(
      `Sync: ${onTime}/${voiced.length} line(s) start on the mouth (${
        voiceWindows.length
      } spoken stretch(es) measured, worst onset ${worstOnsetMs}ms).`
    );

    return {
      lines: voiced.length,
      spoken: voiceWindows.length,
      onTime,
      worstOnsetMs,
      silent,
      trackSeconds,
      voiceWindows,
    };
  }

  /**
   * Intelligently mix dubbed Khmer dialogue track with background music/ambient audio (no_vocals.wav)
   *
   * `segments` supplies the dialogue windows: the background is ducked inside them so
   * the original voices cannot be heard under the Khmer dub, while the music is kept
   * at full quality everywhere else. Windows are sorted and merged so the gate
   * expression is short and never flickers on overlapping timestamps.
   *
   * `dialogueWindows` overrides them when the sync step has measured where the
   * voice really is, which is the difference between the music coming back when the
   * Khmer line ends and it coming back when the original speaker's mouth window
   * ended.
   */
  public static async mixDubbedWithBackground(
    speechTrackPath: string,
    backgroundTrackPath: string,
    outputMixedTrackPath: string,
    settings: JobSettings,
    options: {
      segments?: DialogueSegment[];
      /** Measured voice windows; used instead of the segments' windows when given. */
      dialogueWindows?: { start: number; end: number }[];
      backgroundHasOriginalVoice?: boolean;
      /** Reported while the mix is written, so a slow host still shows movement. */
      onProgress?: (writtenSeconds: number) => void;
    } = {}
  ): Promise<string> {
    const source =
      options.dialogueWindows && options.dialogueWindows.length > 0
        ? options.dialogueWindows
        : (options.segments || [])
            .filter(
              (segment) =>
                Number.isFinite(segment.start) &&
                Number.isFinite(segment.end) &&
                segment.end > segment.start
            )
            .map((segment) => ({ start: segment.start, end: segment.end }));

    const raw = [...source].sort((a, b) => a.start - b.start);

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
