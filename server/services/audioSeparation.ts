import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

export interface SeparationResult {
  vocalsPath: string;
  noVocalsPath: string;
  warning?: string;
  /**
   * True when the background track still contains the original voices, which
   * happens when phase cancellation is impossible (effectively mono audio).
   * The mixer uses it to decide how hard to mute the background under dialogue.
   */
  backgroundHasOriginalVoice?: boolean;
}

export interface AudioSeparationProvider {
  name: string;
  isConfigured(): boolean;
  separate(inputWavPath: string, outputDir: string): Promise<SeparationResult>;
}

/**
 * Local DSP Audio Separation using FFmpeg center-channel subtraction + bandpass filters.
 * High speed, zero external dependencies, robust and keeps stereo background music and ambience.
 */
export class DspAudioSeparationProvider implements AudioSeparationProvider {
  name = 'local_dsp';

  isConfigured(): boolean {
    return true; // Always available via native FFmpeg
  }

  async separate(inputWavPath: string, outputDir: string): Promise<SeparationResult> {
    const vocalsPath = path.join(outputDir, 'vocals.wav');
    const noVocalsPath = path.join(outputDir, 'no_vocals.wav');

    try {
      const separation = await FFmpegHelper.separateCenterVocalDsp(inputWavPath, vocalsPath, noVocalsPath);

      // Verify files were generated
      const noVocalsExists = fs.existsSync(noVocalsPath) && fs.statSync(noVocalsPath).size > 1024;

      if (!noVocalsExists) {
        logger.warn('no_vocals.wav was not generated cleanly, falling back to original audio copy');
        fs.copyFileSync(inputWavPath, noVocalsPath);
        return {
          vocalsPath,
          noVocalsPath,
          backgroundHasOriginalVoice: true,
          warning: 'ការញែកសំឡេងមិនទាន់ពេញលេញ។ សំឡេងដើមត្រូវបានរក្សាទុកជាផ្ទៃខាងក្រោយ។ (Audio separation partial; original audio preserved as background.)',
        };
      }

      logger.info(
        separation.backgroundHasOriginalVoice
          ? 'Background keeps the original mix; the original voices will be muted inside each dialogue window.'
          : 'Centre-channel cancellation used for the background; only a light dip is needed under dialogue.'
      );

      return {
        vocalsPath,
        noVocalsPath,
        backgroundHasOriginalVoice: separation.backgroundHasOriginalVoice,
      };
    } catch (err: any) {
      logger.warn('DSP audio separation encountered an issue, continuing gracefully with fallback:', err);
      // Graceful fallback: use original audio as background so job continues smoothly
      fs.copyFileSync(inputWavPath, noVocalsPath);
      fs.copyFileSync(inputWavPath, vocalsPath);

      return {
        vocalsPath,
        noVocalsPath,
        backgroundHasOriginalVoice: true,
        warning: 'ការញែកសំឡេងមិនបានល្អឥតខ្ចោះទេ ប៉ុន្តែវីដេអូនឹងនៅតែដំណើរការបន្ត។ (Audio separation warning; continuing with graceful fallback.)',
      };
    }
  }
}

/**
 * Demucs CLI provider if the user has demucs installed on the host
 */
export class DemucsAudioSeparationProvider implements AudioSeparationProvider {
  name = 'demucs';
  private fallback = new DspAudioSeparationProvider();

  isConfigured(): boolean {
    return process.env.AUDIO_SEPARATION_PROVIDER === 'demucs';
  }

  async separate(inputWavPath: string, outputDir: string): Promise<SeparationResult> {
    try {
      const isDemucsInstalled = await new Promise<boolean>((resolve) => {
        const check = spawn('demucs', ['--help']);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      });

      if (!isDemucsInstalled) {
        logger.info('Demucs command not found, using local DSP separation fallback');
        return await this.fallback.separate(inputWavPath, outputDir);
      }

      logger.info('Running demucs vocal separation...');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('demucs', ['--two-stems=vocals', '-o', outputDir, inputWavPath]);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Demucs exited with code ${code}`));
        });
        proc.on('error', reject);
      });

      // Find demucs output
      const baseName = path.basename(inputWavPath, path.extname(inputWavPath));
      const modelDir = path.join(outputDir, 'htdemucs', baseName);
      const demucsVocals = path.join(modelDir, 'vocals.wav');
      const demucsNoVocals = path.join(modelDir, 'no_vocals.wav');

      const targetVocals = path.join(outputDir, 'vocals.wav');
      const targetNoVocals = path.join(outputDir, 'no_vocals.wav');

      if (fs.existsSync(demucsVocals) && fs.existsSync(demucsNoVocals)) {
        fs.copyFileSync(demucsVocals, targetVocals);
        fs.copyFileSync(demucsNoVocals, targetNoVocals);
        return { vocalsPath: targetVocals, noVocalsPath: targetNoVocals };
      }

      return await this.fallback.separate(inputWavPath, outputDir);
    } catch (e: any) {
      logger.warn('Demucs separation failed, gracefully falling back to DSP:', e);
      return await this.fallback.separate(inputWavPath, outputDir);
    }
  }
}

/**
 * `audio-separator` (UVR / MDX-Net / MDX23 / Demucs) stem provider.
 *
 * The Node/FFmpeg host cannot run UVR models by itself, so the model runs in the
 * small sidecar service in `tools/audio-separator-server/` — the same
 * `audio-separator` package TachiDUBB Studio uses — and this provider talks to it
 * over HTTP: upload the extracted WAV, download `vocals` + `instrumental`.
 *
 * Because the model removes the dialogue from the background completely, the
 * returned background is reported as carrying no original voice, which is what
 * lets the mixer hold the music at full level under the Khmer dialogue (a gentle
 * 6 dB dip) instead of gating it down to -30 dB.
 *
 * Anything that goes wrong — service down, timeout, empty stems — falls back to the
 * local DSP provider, so separation never fails a job.
 */
export class AudioSeparatorHttpProvider implements AudioSeparationProvider {
  name = 'audio_separator';
  private fallback = new DspAudioSeparationProvider();

  isConfigured(): boolean {
    return Boolean(this.serviceUrl());
  }

  /** Base URL of the sidecar, e.g. `http://127.0.0.1:8920` (trailing slashes dropped). */
  private serviceUrl(): string {
    return (process.env.AUDIO_SEPARATOR_URL || '').trim().replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    const apiKey = (process.env.AUDIO_SEPARATOR_API_KEY || '').trim();
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /** Model file name the sidecar should load; empty means "whatever it defaults to". */
  getModelName(): string {
    return (process.env.AUDIO_SEPARATOR_MODEL || '').trim() || 'UVR-MDX-NET-Inst_HQ_3';
  }

  async separate(inputWavPath: string, outputDir: string): Promise<SeparationResult> {
    const vocalsPath = path.join(outputDir, 'vocals.wav');
    const noVocalsPath = path.join(outputDir, 'no_vocals.wav');
    const base = this.serviceUrl();

    if (!base) {
      logger.info('AUDIO_SEPARATOR_URL is not set; using the local DSP separation fallback');
      return this.fallback.separate(inputWavPath, outputDir);
    }

    // Separate requests are minutes long on a CPU-only box, so the default budget
    // is generous. `AUDIO_SEPARATOR_TIMEOUT_MS` tunes it per deployment.
    const timeoutMs = Number(process.env.AUDIO_SEPARATOR_TIMEOUT_MS || '1800000');

    try {
      const form = new FormData();
      // openAsBlob streams the file lazily, so a multi-hundred-MB WAV is not read
      // into memory just to build the multipart body.
      const blob = await fs.openAsBlob(inputWavPath, { type: 'audio/wav' });
      form.append('audio', blob, path.basename(inputWavPath));
      form.append('model', this.getModelName());

      logger.info(`Separating stems with the audio-separator service at ${base}...`);
      const upload = await fetch(`${base}/separate`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!upload.ok) {
        const detail = await upload.text().catch(() => '');
        throw new Error(`audio-separator service responded ${upload.status}: ${detail.slice(0, 200)}`);
      }

      const payload = (await upload.json()) as {
        vocals?: string;
        instrumental?: string;
        model?: string;
      };

      if (!payload.vocals || !payload.instrumental) {
        throw new Error('audio-separator service did not return both stem locations');
      }

      await this.downloadStem(base, payload.vocals, vocalsPath, timeoutMs);
      await this.downloadStem(base, payload.instrumental, noVocalsPath, timeoutMs);

      const usable = (p: string) => fs.existsSync(p) && fs.statSync(p).size > 1024;
      if (!usable(vocalsPath) || !usable(noVocalsPath)) {
        throw new Error('audio-separator returned empty stems');
      }

      logger.info(`audio-separator stems ready (model: ${payload.model || this.getModelName()})`);
      return {
        vocalsPath,
        noVocalsPath,
        // Dialogue is gone from the background, so the music can stay loud.
        backgroundHasOriginalVoice: false,
      };
    } catch (err: any) {
      logger.warn('audio-separator separation failed, falling back to the local DSP provider:', err);
      const result = await this.fallback.separate(inputWavPath, outputDir);
      return {
        ...result,
        warning:
          'ការញែកភ្លេងដោយម៉ូឌែល (audio-separator) មិនបានសម្រេច ដូច្នេះវីដេអូនេះប្រើវិធីញែកធម្មតាជំនួសវិញ។ (Model separation was unavailable for this job; used the built-in DSP fallback.)',
      };
    }
  }

  /** Stem fields may be absolute URLs or paths relative to the sidecar root. */
  private resolveStemUrl(base: string, location: string): string {
    if (/^https?:\/\//i.test(location)) return location;
    return `${base}${location.startsWith('/') ? '' : '/'}${location}`;
  }

  private async downloadStem(base: string, location: string, target: string, timeoutMs: number): Promise<void> {
    const res = await fetch(this.resolveStemUrl(base, location), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) {
      throw new Error(`stem download failed (${res.status}) for ${location}`);
    }
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(target));
  }
}

export function getAudioSeparationProvider(): AudioSeparationProvider {
  const provider = (process.env.AUDIO_SEPARATION_PROVIDER || 'local_dsp').toLowerCase();
  if (provider === 'audio_separator' || provider === 'audio-separator') {
    return new AudioSeparatorHttpProvider();
  }
  if (provider === 'demucs') {
    return new DemucsAudioSeparationProvider();
  }
  return new DspAudioSeparationProvider();
}
