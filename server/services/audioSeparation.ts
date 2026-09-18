import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
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

export function getAudioSeparationProvider(): AudioSeparationProvider {
  const provider = (process.env.AUDIO_SEPARATION_PROVIDER || 'local_dsp').toLowerCase();
  if (provider === 'demucs') {
    return new DemucsAudioSeparationProvider();
  }
  return new DspAudioSeparationProvider();
}
