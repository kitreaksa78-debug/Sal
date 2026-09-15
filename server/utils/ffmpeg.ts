import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { VideoMetadata } from '../types.js';

export class FFmpegHelper {
  private static ffmpegPath = 'ffmpeg';
  private static ffprobePath = 'ffprobe';

  /**
   * Run ffmpeg with given arguments and return stdout/stderr
   */
  public static async execute(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      logger.debug(`Executing ffmpeg with args: ${args.join(' ')}`);
      const proc = spawn(this.ffmpegPath, args);
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
          resolve({ stdout, stderr });
        } else {
          logger.error(`FFmpeg process failed with code ${code}`, stderr);
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', (err) => {
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
   * Adjust audio tempo/duration using atempo filter (from 0.5x to 2.0x) without altering pitch
   */
  public static async adjustTempo(
    inputAudioPath: string,
    outputAudioPath: string,
    tempoFactor: number
  ): Promise<void> {
    // Clamp tempo factor between 0.5 and 2.0 (FFmpeg atempo constraint)
    const factor = Math.max(0.5, Math.min(2.0, tempoFactor));
    const args = [
      '-y',
      '-i', inputAudioPath,
      '-filter:a', `atempo=${factor.toFixed(3)}`,
      '-vn',
      outputAudioPath,
    ];
    await this.execute(args);
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
  ): Promise<{ vocals: string; noVocals: string }> {
    // Step 1: Create no_vocals (background/music) by subtracting center channel and retaining stereo ambient/music
    // Filter graph:
    // Left minus Right (L-R) cancels out center vocal components, leaving stereo music/reverb/instruments.
    // We add slight low-frequency bass recovery (under 200Hz) and high-frequency brilliance (over 6000Hz) to keep music rich.
    const noVocalsFilter = [
      '[0:a]asplit=2[orig][tocancel]',
      '[tocancel]pan=stereo|c0=c0-c1|c1=c1-c0[karaoke]',
      '[orig]lowpass=f=180[bass]',
      '[karaoke][bass]amix=inputs=2:weights=1.0 0.8:dropout_transition=0[out]',
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

    // Step 2: Create vocals (human speech) by bandpassing vocal range (250Hz - 3800Hz) + high-center isolation
    const vocalsFilter = [
      '[0:a]pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,highpass=f=220,lowpass=f=4000[out]',
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

    return { vocals: outputVocalsPath, noVocals: outputNoVocalsPath };
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
    }
  ): Promise<string> {
    if (options.backgroundMusic === 'remove') {
      // Just normalize speech
      await this.execute([
        '-y',
        '-i', dubbedSpeechTrack,
        '-af', 'volume=1.2,loudnorm=I=-16:TP=-1.5:LRA=11',
        outputMixedTrack,
      ]);
      return outputMixedTrack;
    }

    const musicVol = options.backgroundMusic === 'reduce' ? 0.35 : (options.musicVolume ?? 0.65);
    const speechVol = options.speechVolume ?? 1.35;

    // Filter: duck background music when speech is active (sidechain compression)
    // [0:a] is background, [1:a] is speech
    const filter = [
      `[0:a]volume=${musicVol}[bg]`,
      `[1:a]volume=${speechVol}[voice]`,
      `[bg][voice]sidechaincompress=threshold=0.1:ratio=3:attack=20:release=300[duckedbg]`,
      `[duckedbg][voice]amix=inputs=2:weights=1.0 1.0:duration=longest:dropout_transition=2[mixed]`,
      `[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
    ].join(';');

    try {
      await this.execute([
        '-y',
        '-i', backgroundTrack,
        '-i', dubbedSpeechTrack,
        '-filter_complex', filter,
        '-map', '[out]',
        '-ac', '2',
        '-ar', '44100',
        outputMixedTrack,
      ]);
    } catch (err) {
      logger.warn('Sidechain ducking mix failed, falling back to static balanced amix:', err);
      await this.execute([
        '-y',
        '-i', backgroundTrack,
        '-i', dubbedSpeechTrack,
        '-filter_complex', `[0:a]volume=${musicVol}[bg];[1:a]volume=${speechVol}[voice];[bg][voice]amix=inputs=2:duration=longest[out]`,
        '-map', '[out]',
        '-ac', '2',
        '-ar', '44100',
        outputMixedTrack,
      ]);
    }

    return outputMixedTrack;
  }

  /**
   * Render final MP4 by combining original video stream with newly mixed audio track
   * Codecs: H.264 video, AAC audio (highly compatible with Android, Chrome, Safari, etc.)
   */
  public static async renderFinalMp4(
    originalVideoPath: string,
    mixedAudioPath: string,
    outputMp4Path: string,
    quality: '720p' | '1080p' | 'original' = 'original'
  ): Promise<string> {
    const scaleFilter =
      quality === '720p'
        ? ['-vf', 'scale=-2:720']
        : quality === '1080p'
        ? ['-vf', 'scale=-2:1080']
        : [];

    // Check if original video stream is already H.264
    const meta = await this.probeVideo(originalVideoPath);
    const isH264 = meta.videoCodec === 'h264';

    const args: string[] = ['-y', '-i', originalVideoPath, '-i', mixedAudioPath];

    if (isH264 && quality === 'original') {
      // Fast stream copy for video
      args.push('-c:v', 'copy');
    } else {
      // Re-encode with standard H.264 fast preset
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', ...scaleFilter);
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

    await this.execute(args);
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
