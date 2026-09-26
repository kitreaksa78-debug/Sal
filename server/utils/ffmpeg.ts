import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { logger } from './logger.js';
import { resolveSubtitleFontsDir } from './subtitleFonts.js';
import { VideoMetadata } from '../types.js';

/**
 * Escape one value for FFmpeg's filtergraph parser.
 *
 * The parser treats `:` as an option separator, `,` as a filter separator and
 * `\` / `'` / `[` / `]` / `;` as syntax, so a path carrying any of them has to
 * be escaped or the whole filter chain is misread. Ordinary paths come out of
 * this unchanged.
 */
function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;');
}

/**
 * How long one FFmpeg run may take before it is killed.
 *
 * Generous by default because a free host is slow by design, but finite: a run
 * that never returns must surface as a failed step with a reason, not as a job
 * that sits on one percentage forever.
 */
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || '1800000');

/** Optional behaviour for one FFmpeg run. */
export interface FfmpegRunOptions {
  /** Receives the seconds FFmpeg has written. Requires `totalSeconds`. */
  onProgress?: (writtenSeconds: number) => void;
  /** Media length the progress is measured against, in seconds. */
  totalSeconds?: number;
  /** Watchdog for this run only; 0 disables it. */
  timeoutMs?: number;
}

export class FFmpegHelper {
  // Binary resolution order: explicit env override -> bundled static binary -> system PATH.
  // The bundled binaries keep media processing working on hosts without a system FFmpeg.
  private static ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || 'ffmpeg';
  private static ffprobePath = process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe';

  /**
   * Run ffmpeg with given arguments and return stdout/stderr.
   *
   * `onProgress` turns on FFmpeg's own `-progress` stream so a long step can
   * report how much audio/video it has actually written. The final steps of the
   * pipeline (mixing, rendering) are the slow ones on a free host, and without
   * this the job sat on one percentage for minutes with no sign of life.
   *
   * Every run also gets a watchdog: a throttled instance can leave FFmpeg busy
   * for a long time, but a process that never returns would hold the job at that
   * percentage forever, so it is killed and reported instead.
   */
  public static async execute(
    args: string[],
    options: FfmpegRunOptions = {}
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const reportProgress = Boolean(options.onProgress && options.totalSeconds);
      const finalArgs = reportProgress ? ['-nostats', '-progress', 'pipe:1', ...args] : args;
      logger.debug(`Executing ffmpeg with args: ${finalArgs.join(' ')}`);
      const proc = spawn(this.ffmpegPath, finalArgs);
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeoutMs = options.timeoutMs ?? FFMPEG_TIMEOUT_MS;
      const watchdog =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              const limit =
                timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
              logger.error(`FFmpeg ran longer than ${limit} and was stopped.`);
              proc.kill('SIGKILL');
              reject(new Error(`FFmpeg ran longer than ${limit} and was stopped.`));
            }, timeoutMs)
          : null;
      watchdog?.unref?.();

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        if (!reportProgress) return;
        // `-progress` emits key=value lines; out_time_us is microseconds written
        // so far, which is the honest measure of how far this step has got.
        for (const line of text.split('\n')) {
          const match = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
          if (!match) continue;
          const written = Number(match[1]) / 1_000_000;
          if (Number.isFinite(written)) options.onProgress!(written);
        }
      });

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          logger.error(`FFmpeg process failed with code ${code}`, stderr);
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        logger.error('Failed to start FFmpeg process', err);
        reject(err);
      });
    });
  }

  /**
   * Run ffprobe with given arguments and return stdout
   */
  public static async probeExecute(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffprobePath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`ffprobe failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Probe video file to get metadata (duration, width, height, codecs, size)
   */
  public static async probeVideo(filePath: string): Promise<VideoMetadata> {
    const stats = fs.statSync(filePath);
    try {
      const output = await this.probeExecute([
        '-v', 'error',
        '-show_entries', 'format=duration,size:stream=codec_name,codec_type,width,height',
        '-of', 'json',
        filePath,
      ]);

      const data = JSON.parse(output);
      const streams = data.streams || [];
      const videoStream = streams.find((s: any) => s.codec_type === 'video');
      const audioStream = streams.find((s: any) => s.codec_type === 'audio');
      const duration = parseFloat(data.format?.duration || videoStream?.duration || '0');

      return {
        duration: isNaN(duration) ? 0 : duration,
        width: videoStream?.width,
        height: videoStream?.height,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name,
        sizeBytes: stats.size,
      };
    } catch (err) {
      logger.warn(`ffprobe failed for ${filePath}, falling back to basic stat:`, err);
      return {
        duration: 0,
        sizeBytes: stats.size,
      };
    }
  }

  /**
   * Extract audio from video file to 16kHz or 44.1kHz WAV
   */
  public static async extractAudio(
    videoPath: string,
    outputPath: string,
    sampleRate: number = 44100
  ): Promise<string> {
    const args = [
      '-y',
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', sampleRate.toString(),
      '-ac', '2',
      outputPath,
    ];
    await this.execute(args);
    return outputPath;
  }

  /**
   * Measure precise duration of an audio file in seconds
   */
  public static async getAudioDuration(audioPath: string): Promise<number> {
    try {
      const output = await this.probeExecute([
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ]);
      const dur = parseFloat(output.trim());
      return isNaN(dur) ? 0 : dur;
    } catch (e) {
      logger.warn(`Failed to get duration for ${audioPath}:`, e);
      return 0;
    }
  }

  /**
   * The audio filter that cuts a line to `trim` seconds and fades the very end.
   *
   * Cutting speech dead mid-syllable is what a listener hears as a broken, choppy
   * dub, so every hard cut ends in a short fade. The fade is anchored to the cut
   * point, which means a line that finishes before it is never touched: the fade
   * only exists where the cut actually happens.
   */
  public static slotTrimChain(trim: number, fadeSeconds?: number): string {
    const fade = Math.min(
      fadeSeconds ?? Number(process.env.SPEECH_TRIM_FADE_SECONDS || '0.12'),
      Math.max(0, trim / 3)
    );
    const parts = [`atrim=end=${trim.toFixed(3)}`, 'asetpts=PTS-STARTPTS'];
    if (fade > 0.005) {
      parts.push(`afade=t=out:st=${Math.max(0, trim - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
    }
    return parts.join(',');
  }

  /** Build a safe atempo chain for any factor using 0.5..2.0 steps. */
  public static buildAtempoChain(factor: number): string {
    const clamped = Math.max(0.25, Math.min(4.0, factor));
    // Decompose into 0.5..2.0 pieces
    let remaining = clamped;
    const parts: string[] = [];
    // Push 2.0s while >2
    while (remaining > 2.0 + 1e-6) {
      parts.push('atempo=2.000');
      remaining /= 2.0;
    }
    while (remaining < 0.5 - 1e-6) {
      parts.push('atempo=0.500');
      remaining /= 0.5;
    }
    parts.push(`atempo=${remaining.toFixed(3)}`);
    return parts.join(',');
  }

  /**
   * Adjust audio tempo/duration using atempo filter without altering pitch.
   * Supports any factor via chained atempo (FFmpeg single atempo is 0.5..2.0).
   */
  public static async adjustTempo(
    inputAudioPath: string,
    outputAudioPath: string,
    tempoFactor: number
  ): Promise<void> {
    // Keep within broadly safe range; chain handles >2 or <0.5
    const factor = Math.max(0.25, Math.min(4.0, tempoFactor));
    const chain = this.buildAtempoChain(factor);
    const args = [
      '-y',
      '-i', inputAudioPath,
      '-filter:a', chain,
      '-vn',
      outputAudioPath,
    ];
    await this.execute(args);
  }

  /**
   * Fit generated speech into the original slot exactly so lip-sync is 100%:
   * - If duration is within 8% of slot -> keep natural (no tempo) to preserve voice.
   * - If longer -> speed up capped at maxTempo, then hard-trim to slot so it never
   *   bleeds into the next line. Trim is last resort; tempo cap keeps voice human.
   * - If much shorter (<75% of slot) -> keep natural duration; the assembler will
   *   leave silence for the rest of the slot (no artificial slow-down).
   * Returns measured final duration.
   */
  /**
   * Make one synthesized line occupy its slot on the timeline.
   *
   * Three things have to hold at once for the Khmer voice to land on the original
   * mouth movement: the line starts when the speaker starts, it finishes inside
   * the slot, and it is not cut mid-word.
   *
   * TTS engines pad every line with silence, so the raw file is measured wrong
   * twice over — the padding makes a line look longer than it is, and the leading
   * padding pushes the actual voice away from the mouth. So the padding is
   * removed first, the fit is judged on the speech that is left, and a speed-up
   * within `maxTempo` is the normal way to make it fit. Only a line that needs
   * more than the cap is trimmed, and that is logged as the real compromise it
   * is rather than presented as a clean fit.
   */
  public static async fitAudioToSlot(
    inputAudioPath: string,
    outputAudioPath: string,
    slotDuration: number,
    maxTempo: number = 1.5
  ): Promise<number> {
    const rawDuration = await this.getAudioDuration(inputAudioPath);
    if (!rawDuration || !slotDuration || slotDuration < 0.35) {
      fs.copyFileSync(inputAudioPath, outputAudioPath);
      return await this.getAudioDuration(outputAudioPath);
    }

    const speechDuration = await this.stripSilence(inputAudioPath, outputAudioPath);

    // A line that is silent from start to finish has nothing to place; hand the
    // original through rather than an empty file.
    if (speechDuration <= 0.05) {
      fs.copyFileSync(inputAudioPath, outputAudioPath);
      return rawDuration;
    }

    const ratio = speechDuration / slotDuration;

    // Already fits — a little slack either way is natural delivery.
    if (ratio <= 1.04) {
      if (ratio < 0.92) {
        logger.debug(
          `Slot ${slotDuration.toFixed(2)}s: speech ${speechDuration.toFixed(2)}s is shorter; the pause carries it.`
        );
      }
      return speechDuration;
    }

    const needed = Math.min(maxTempo, ratio);
    const tempoPath = `${outputAudioPath}.tempo.wav`;
    await this.execute([
      '-y',
      '-i', outputAudioPath,
      '-filter:a', `${this.buildAtempoChain(needed)},asetpts=PTS-STARTPTS`,
      '-vn',
      tempoPath,
    ]);
    let outDur = await this.getAudioDuration(tempoPath);

    if (outDur > slotDuration + 0.01) {
      // Even at the cap this line is too long, so cutting it is the only way to
      // hold the sync. The trim stays, but it is reported: a clipped syllable is
      // audible and the line it came from is worth knowing. The cut itself ends
      // in a fade (see slotTrimChain) so it sounds cut short rather than chopped.
      await this.execute([
        '-y',
        '-i', tempoPath,
        '-filter:a', this.slotTrimChain(slotDuration),
        '-vn',
        outputAudioPath,
      ]);
      outDur = await this.getAudioDuration(outputAudioPath);
      logger.warn(
        `Slot ${slotDuration.toFixed(2)}s: speech ${speechDuration.toFixed(2)}s needs ${ratio.toFixed(2)}x but is capped at ${maxTempo}x; trimmed to ${outDur.toFixed(2)}s (a syllable may be cut).`
      );
    } else {
      fs.renameSync(tempoPath, outputAudioPath);
      logger.info(
        `Slot ${slotDuration.toFixed(2)}s: fitted speech ${speechDuration.toFixed(2)}s -> ${outDur.toFixed(2)}s (${needed.toFixed(2)}x).`
      );
    }

    if (fs.existsSync(tempoPath)) {
      try {
        fs.unlinkSync(tempoPath);
      } catch {
        /* temp file, discarded with the job folder */
      }
    }
    return outDur;
  }

  /**
   * Drop the silence a TTS engine pads around a line so the voice begins where
   * the speaker begins. A little is kept at each end so the cut does not click.
   */
  private static async stripSilence(inputPath: string, outputPath: string): Promise<number> {
    const threshold = process.env.TTS_SILENCE_DB || '-45dB';
    const keepSeconds = process.env.TTS_SILENCE_KEEP || '0.04';
    const trim = `silenceremove=start_periods=1:start_silence=${keepSeconds}:start_threshold=${threshold}:detection=peak`;
    try {
      await this.execute([
        '-y',
        '-i', inputPath,
        '-filter:a', `${trim},areverse,${trim},areverse,asetpts=PTS-STARTPTS`,
        '-vn',
        outputPath,
      ]);
      return await this.getAudioDuration(outputPath);
    } catch (err) {
      logger.warn('Could not trim silence from a synthesized line; using it as-is:', err);
      fs.copyFileSync(inputPath, outputPath);
      return await this.getAudioDuration(outputPath);
    }
  }

  /**
   * Separate audio into vocals and no_vocals using DSP center-cancellation + spectral bandpass
   * In typical mixes, vocals sit centered in the stereo image, while music and stereo effects have out-of-phase L/R components.
   * This extracts:
   * 1) no_vocals.wav (music & background sound)
   * 2) vocals.wav (extracted dialog track)
   */
  public static async separateCenterVocalDsp(
    inputAudioPath: string,
    outputVocalsPath: string,
    outputNoVocalsPath: string
  ): Promise<{ vocals: string; noVocals: string; backgroundHasOriginalVoice: boolean }> {
    // How much genuinely stereo content does this file have?
    // Phase cancellation (L-R) deletes anything identical in both channels, which is
    // exactly where centred dialogue lives. The metric below is how far the L-R
    // difference channel sits *below* the full mix: a large drop means the two
    // channels are nearly identical (mono content), so cancelling would wipe out the
    // music as well and leave only artefacts. Measure before trusting it.
    const cancelDropDb = await this.measureStereoWidthDb(inputAudioPath);
    const cancelThresholdDb = Number(process.env.AUDIO_MONO_CANCEL_DB || '18');
    const effectivelyMono = cancelDropDb === null || cancelDropDb >= cancelThresholdDb;

    if (effectivelyMono) {
      // Nothing to cancel. Keep the untouched original mix as the background so the
      // music survives at full quality, and let the mixer mute it inside the speech
      // windows — that is what removes the original voices in this case.
      fs.copyFileSync(inputAudioPath, outputNoVocalsPath);
      logger.info(
        cancelDropDb === null
          ? 'Could not measure stereo width; keeping the full original mix as background and muting it under dialogue.'
          : `Audio is effectively mono (L-R sits ${cancelDropDb.toFixed(1)} dB below the mix); keeping the full original mix as background and muting it under dialogue instead of phase cancelling.`
      );
    } else {
      // Real stereo: cancel the centre for the background. Bass is recovered from the
      // difference channel itself — never from the original mix, because feeding the
      // original back in re-injects the dialogue's own low frequencies (its vocal
      // fundamentals) into the \"music\" track.
      const noVocalsFilter = [
        '[0:a]pan=stereo|c0=c0-c1|c1=c1-c0,asplit=2[karaoke][bassfeed]',
        '[bassfeed]lowpass=f=150,bass=g=5:f=110[bass]',
        '[karaoke][bass]amix=inputs=2:weights=1.0 0.6:dropout_transition=0[out]',
      ].join(';');

      try {
        await this.execute([
          '-y',
          '-i', inputAudioPath,
          '-filter_complex', noVocalsFilter,
          '-map', '[out]',
          '-ac', '2',
          outputNoVocalsPath,
        ]);
      } catch (err) {
        logger.warn('Advanced no_vocals filter failed, falling back to simple phase inversion:', err);
        // Fallback simple stereo phase cancellation
        await this.execute([
          '-y',
          '-i', inputAudioPath,
          '-af', 'pan=stereo|c0=c0-c1|c1=c1-c0',
          '-ac', '2',
          outputNoVocalsPath,
        ]);
      }
    }

    // Step 2: Build the stem the transcriber listens to.
    // Centre extraction already cancels the out-of-phase music; on top of that the
    // signal is band-limited to the speech range (Whisper hears up to ~8 kHz, so the
    // old 4 kHz cut was throwing sibilants away), the steady background hiss/music
    // bed is reduced, and the level is evened out so quiet lines are not skipped.
    // This is what turns \"guessed\" transcripts into the right words.
    const enhanceSpeech = process.env.STT_SPEECH_ENHANCE !== '0';
    const vocalsFilter = [
      '[0:a]pan=mono|c0=0.5*c0+0.5*c1,' +
        (enhanceSpeech
          ? 'highpass=f=90,lowpass=f=7800,afftdn=nr=12:nf=-30,speechnorm=e=12.5:r=0.0001:l=1'
          : 'highpass=f=90,lowpass=f=7800') +
        '[out]',
    ].join(';');

    try {
      await this.execute([
        '-y',
        '-i', inputAudioPath,
        '-filter_complex', vocalsFilter,
        '-map', '[out]',
        '-ac', '2',
        outputVocalsPath,
      ]);
    } catch (err) {
      logger.warn('Vocals filter failed, copying input audio as vocal approximation:', err);
      fs.copyFileSync(inputAudioPath, outputVocalsPath);
    }

    return {
      vocals: outputVocalsPath,
      noVocals: outputNoVocalsPath,
      backgroundHasOriginalVoice: effectivelyMono,
    };
  }

  /**
   * Mean level (dBFS) of an audio file, optionally only its first `limitSeconds`.
   * Returns null when the level cannot be read.
   */
  public static async measureMeanVolumeDb(
    audioPath: string,
    limitSeconds?: number
  ): Promise<number | null> {
    const args = ['-hide_banner'];
    if (limitSeconds && limitSeconds > 0) args.push('-t', String(limitSeconds));
    args.push('-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-');

    try {
      const { stderr } = await this.execute(args);
      const match = stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/);
      if (!match) return null;
      if (match[1] === '-inf') return -100;
      const value = Number(match[1]);
      return Number.isFinite(value) ? value : null;
    } catch (err) {
      logger.warn(`Could not measure mean volume for ${path.basename(audioPath)}:`, err);
      return null;
    }
  }

  /**
   * How far below the full mix the L-R difference channel sits, in dB.
   * A large value means the channels are nearly identical, i.e. mono content.
   */
  private static async measureStereoWidthDb(audioPath: string): Promise<number | null> {
    // Returns (mix level - difference-channel level). Large means effectively mono.
    const probeSeconds = Number(process.env.AUDIO_WIDTH_PROBE_SECONDS || '90');
    const probePath = path.join(
      path.dirname(audioPath),
      `stereo_width_probe_${Date.now()}.wav`
    );

    try {
      const fullDb = await this.measureMeanVolumeDb(audioPath, probeSeconds);

      await this.execute([
        '-y',
        '-hide_banner',
        '-t', String(probeSeconds),
        '-i', audioPath,
        '-af', 'pan=stereo|c0=c0-c1|c1=c1-c0',
        '-ac', '2',
        probePath,
      ]);

      const sideDb = await this.measureMeanVolumeDb(probePath);
      if (fullDb === null || sideDb === null) return null;
      return fullDb - sideDb;
    } catch (err) {
      logger.warn('Stereo width probe failed; treating the background as if it still holds the original voices:', err);
      return null;
    } finally {
      if (fs.existsSync(probePath)) {
        try { fs.unlinkSync(probePath); } catch {}
      }
    }
  }

  /**
   * Build a frame-by-frame gain expression that drops the background to
   * `gateDepthDb` inside every dialogue window and returns to full level
   * between them, with a short ramp so the transitions do not click.
   */
  private static buildDialogueGateExpression(
    windows: { start: number; end: number }[],
    musicVolume: number,
    gateDepthDb: number,
    padMs: number
  ): string | null {
    const valid = windows.filter(
      (w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start
    );
    if (valid.length === 0) return null;

    const pad = Math.max(0, padMs) / 1000;
    const rampSeconds = 0.05;

    const terms = valid.map((w) => {
      const start = Math.max(0, w.start - pad).toFixed(3);
      const end = (w.end + pad).toFixed(3);
      return (
        `clip((t-${start})/${rampSeconds},0,1)*` +
        `clip((${end}-t)/${rampSeconds},0,1)`
      );
    });

    const gate = `min(1,${terms.map((t) => `(${t})`).join('+')})`;
    const floor = Math.pow(10, gateDepthDb / 20);
    const expression = `${musicVolume}-(${musicVolume - floor})*${gate}`;

    logger.info(
      `Background gate: ${valid.length} dialogue window(s), depth ${gateDepthDb} dB, pad ${padMs} ms.`
    );
    return expression;
  }

  /**
   * Mix dubbed Khmer speech track with background audio (no_vocals.wav)
   * Applies gentle sidechain ducking or balanced volume normalization
   */
  public static async mixDubbedAudio(
    dubbedSpeechTrack: string,
    backgroundTrack: string,
    outputMixedTrack: string,
    options: {
      backgroundMusic: 'keep' | 'reduce' | 'remove';
      speechVolume?: number; // default 1.2
      musicVolume?: number;  // default 0.6
      /** Dialogue windows whose original voices must not be audible. */
      dialogueWindows?: { start: number; end: number }[];
      /** True when the background still carries the original voices (mono source). */
      backgroundHasOriginalVoice?: boolean;
      /** Reported while the mix is written, against the background's length. */
      onProgress?: (writtenSeconds: number) => void;
    }
  ): Promise<string> {
    // Mixing walks the whole track, so its own length is what progress is
    // measured against. A failed probe just means no sub-progress is reported.
    const progress = options.onProgress
      ? { onProgress: options.onProgress, totalSeconds: await this.getAudioDuration(backgroundTrack) }
      : undefined;

    if (options.backgroundMusic === 'remove') {
      // Just normalize speech
      await this.execute(
        [
          '-y',
          '-i', dubbedSpeechTrack,
          '-af', 'volume=1.2,loudnorm=I=-16:TP=-1.5:LRA=11',
          outputMixedTrack,
        ],
        { onProgress: options.onProgress, totalSeconds: await this.getAudioDuration(dubbedSpeechTrack) }
      );
      return outputMixedTrack;
    }

    const musicVol = options.backgroundMusic === 'reduce' ? 0.35 : (options.musicVolume ?? 0.65);
    const speechVol = options.speechVolume ?? 1.35;

    // Duck the background inside each dialogue window instead of muting it.
    // A professional dub lowers the soundtrack a few dB under the voice and keeps
    // it playing; cutting it to silence every time somebody speaks is the single
    // most obvious \"this video was dubbed\" give-away, and it is what a whole-band
    // -60 dB gate used to do. So:
    //   * centre-cancelled background (only bleed left) -> a light 6 dB dip, the
    //     music stays continuous and the Khmer voice simply sits on top of it;
    //   * mono source (no separation possible, original voices are still in the
    //     background) -> a deep but still not silent dip, so bass and air stay
    //     audible under the dub.
    const gateDepthDb = options.backgroundHasOriginalVoice
      ? Number(process.env.BACKGROUND_GATE_DB_MONO || '-30')
      : Number(process.env.BACKGROUND_GATE_DB_STEREO || '-6');
    const gatePadMs = Number(process.env.BACKGROUND_GATE_PAD_MS || '150');

    const gateExpression = this.buildDialogueGateExpression(
      options.dialogueWindows || [],
      musicVol,
      gateDepthDb,
      gatePadMs
    );

    const backgroundStage = gateExpression
      ? `[0:a]volume=volume='${gateExpression}':eval=frame[bg]`
      : `[0:a]volume=${musicVol}[bg]`;

    // Filter: duck the background music under the speech (sidechain compression).
    // [0:a] is background, [1:a] is speech. The speech has to be split because a
    // filter output can only be consumed once, and it feeds both the sidechain key
    // and the mix. normalize=0 keeps the per-input volumes as set above.
    const filter = [
      backgroundStage,
      `[1:a]volume=${speechVol},asplit=2[voiceKey][voiceMix]`,
      `[bg][voiceKey]sidechaincompress=threshold=0.1:ratio=3:attack=20:release=300[duckedbg]`,
      `[duckedbg][voiceMix]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[mixed]`,
      `[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
    ].join(';');

    try {
      await this.execute(
        [
          '-y',
          '-i', backgroundTrack,
          '-i', dubbedSpeechTrack,
          '-filter_complex', filter,
          '-map', '[out]',
          '-ac', '2',
          '-ar', '44100',
          outputMixedTrack,
        ],
        progress
      );
    } catch (err) {
      logger.warn('Sidechain ducking mix failed, falling back to static balanced amix:', err);
      await this.execute(
        [
          '-y',
          '-i', backgroundTrack,
          '-i', dubbedSpeechTrack,
          '-filter_complex', `${backgroundStage};[1:a]volume=${speechVol}[voice];[bg][voice]amix=inputs=2:duration=longest[out]`,
          '-map', '[out]',
          '-ac', '2',
          '-ar', '44100',
          outputMixedTrack,
        ],
        progress
      );
    }

    return outputMixedTrack;
  }

  /**
   * Render final MP4 by combining original video stream with newly mixed audio track
   * Codecs: H.264 video, AAC audio (highly compatible with Android, Chrome, Safari, etc.)
   */
  /**
   * Render the final MP4, optionally painting the Khmer subtitles onto the
   * picture.
   *
   * `subtitleAssPath` is an ASS file (see VideoRenderingService.generateAss).
   * When it is given, libass draws it over every frame with the Khmer font from
   * `assets/fonts`, which is what puts readable Khmer text **in** the downloaded
   * video rather than only in a side-car file the player may never show.
   *
   * Burned-in text forces a video re-encode, and a host without a Khmer font (or
   * without libass) must not lose the whole job over it: the render is attempted
   * with the subtitles and, if that fails, retried without them.
   */
  public static async renderFinalMp4(
    originalVideoPath: string,
    mixedAudioPath: string,
    outputMp4Path: string,
    quality: '720p' | '1080p' | 'original' = 'original',
    /** Reported while the MP4 is written, against the source video's length. */
    onProgress?: (writtenSeconds: number) => void,
    /** ASS file to burn into the picture. Omitted when the studio turned subtitles off. */
    subtitleAssPath?: string
  ): Promise<string> {
    // Check if original video stream is already H.264
    const meta = await this.probeVideo(originalVideoPath);
    const isH264 = meta.videoCodec === 'h264';

    const scale = quality === '720p' ? 'scale=-2:720' : quality === '1080p' ? 'scale=-2:1080' : '';

    const buildArgs = (subtitleFilter: string | null): string[] => {
      const chain = [scale, subtitleFilter].filter(Boolean).join(',');
      const args: string[] = ['-y', '-i', originalVideoPath, '-i', mixedAudioPath];

      if (isH264 && quality === 'original' && !subtitleFilter) {
        // Fast stream copy for video — only possible when nothing is drawn on top.
        args.push('-c:v', 'copy');
      } else {
        // Re-encode with standard H.264 fast preset
        args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22');
        if (chain) args.push('-vf', chain);
      }

      args.push(
        '-c:a', 'aac',
        '-b:a', '192k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-movflags', '+faststart', // web streaming friendly
        '-shortest',
        outputMp4Path
      );
      return args;
    };

    let subtitleFilter: string | null = null;
    if (subtitleAssPath && fs.existsSync(subtitleAssPath)) {
      const fontsDir = await resolveSubtitleFontsDir();
      if (fontsDir) {
        subtitleFilter = `ass=filename=${escapeFilterValue(subtitleAssPath)}:fontsdir=${escapeFilterValue(
          fontsDir
        )}`;
      }
    }

    const runOptions = { onProgress, totalSeconds: onProgress ? meta.duration : undefined };

    if (subtitleFilter) {
      try {
        await this.execute(buildArgs(subtitleFilter), runOptions);
        logger.info('Rendered the final MP4 with burned-in Khmer subtitles.');
        return outputMp4Path;
      } catch (err) {
        logger.warn('Burning subtitles into the video failed; rendering without them:', err);
      }
    }

    await this.execute(buildArgs(null), runOptions);
    return outputMp4Path;
  }

  /**
   * Quality check on the rendered MP4
   * Verifies:
   * 1. Output MP4 file exists and size > 0
   * 2. Video can be opened with ffprobe
   * 3. Duration is reasonable (> 0)
   * 4. Audio stream exists with AAC codec
   * 5. Video stream exists with H.264 codec
   */
  public static async verifyOutputQuality(outputPath: string): Promise<{ valid: boolean; reason?: string }> {
    if (!fs.existsSync(outputPath)) {
      return { valid: false, reason: 'Final MP4 file does not exist on disk' };
    }

    const stat = fs.statSync(outputPath);
    if (stat.size <= 1024) {
      return { valid: false, reason: `Output file is unexpectedly small: ${stat.size} bytes` };
    }

    try {
      const meta = await this.probeVideo(outputPath);
      if (!meta.duration || meta.duration <= 0.1) {
        return { valid: false, reason: 'Invalid or zero duration in output video' };
      }

      if (meta.videoCodec !== 'h264') {
        logger.warn(`Expected H.264 video codec, found: ${meta.videoCodec}`);
      }

      if (meta.audioCodec !== 'aac') {
        logger.warn(`Expected AAC audio codec, found: ${meta.audioCodec}`);
      }

      return { valid: true };
    } catch (e: any) {
      return { valid: false, reason: `Failed to probe output video: ${e.message}` };
    }
  }

  /**
   * Check if FFmpeg and ffprobe are available in the system
   */
  public static async checkAvailability(): Promise<{ available: boolean; version?: string }> {
    try {
      const proc = spawn(this.ffmpegPath, ['-version']);
      let out = '';
      return new Promise((resolve) => {
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) {
            const firstLine = out.split('\n')[0] || '';
            resolve({ available: true, version: firstLine });
          } else {
            resolve({ available: false });
          }
        });
        proc.on('error', () => {
          resolve({ available: false });
        });
      });
    } catch {
      return { available: false };
    }
  }
}
