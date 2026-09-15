import fs from 'fs';
import path from 'path';
import { DialogueSegment, JobSettings } from '../types.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

export class VideoRenderingService {
  /**
   * Format seconds to SRT timestamp format (HH:MM:SS,mmm)
   */
  public static formatSrtTime(seconds: number): string {
    const totalMs = Math.max(0, Math.floor(seconds * 1000));
    const hours = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    const pad = (n: number, z = 2) => String(n).padStart(z, '0');
    return `${pad(hours)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
  }

  /**
   * Format seconds to WebVTT timestamp format (HH:MM:SS.mmm)
   */
  public static formatVttTime(seconds: number): string {
    const totalMs = Math.max(0, Math.floor(seconds * 1000));
    const hours = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    const pad = (n: number, z = 2) => String(n).padStart(z, '0');
    return `${pad(hours)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
  }

  /**
   * Generate SRT format subtitles matching Khmer dialogue
   */
  public static generateSrt(segments: DialogueSegment[]): string {
    const lines: string[] = [];
    let count = 1;

    for (const seg of segments) {
      const text = (seg.khmer || seg.text || '').trim();
      if (!text) continue;

      const startTime = this.formatSrtTime(seg.start);
      const endTime = this.formatSrtTime(seg.end);

      lines.push(`${count}`);
      lines.push(`${startTime} --> ${endTime}`);
      lines.push(text);
      lines.push('');
      count++;
    }

    return lines.join('\n');
  }

  /**
   * Generate WebVTT format subtitles matching Khmer dialogue
   */
  public static generateVtt(segments: DialogueSegment[]): string {
    const lines: string[] = ['WEBVTT', ''];
    let count = 1;

    for (const seg of segments) {
      const text = (seg.khmer || seg.text || '').trim();
      if (!text) continue;

      const startTime = this.formatVttTime(seg.start);
      const endTime = this.formatVttTime(seg.end);

      lines.push(`${count}`);
      lines.push(`${startTime} --> ${endTime}`);
      lines.push(text);
      lines.push('');
      count++;
    }

    return lines.join('\n');
  }

  /**
   * Render final H.264 / AAC MP4 video with new mixed audio
   */
  public static async renderMp4(
    originalVideoPath: string,
    mixedAudioPath: string,
    outputMp4Path: string,
    settings: JobSettings
  ): Promise<string> {
    logger.info(`Rendering final MP4: ${outputMp4Path}`);
    return await FFmpegHelper.renderFinalMp4(
      originalVideoPath,
      mixedAudioPath,
      outputMp4Path,
      settings.outputQuality || 'original'
    );
  }
}
