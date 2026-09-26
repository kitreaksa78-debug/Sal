import fs from 'fs';
import { DialogueSegment, JobSettings } from '../types.js';
import { FFmpegHelper } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

/** The line shown for a segment: the Khmer translation, or the source if there is none. */
function subtitleText(segment: DialogueSegment): string {
  return (segment.khmer || segment.text || '').trim();
}

/**
 * Break one subtitle into rows that fit the frame.
 *
 * libass wraps on spaces, and Khmer runs without them, so a long Khmer line
 * would either be squeezed or run off the screen edge. The rows are therefore
 * cut by hand at roughly as many characters as the frame can carry, preferring
 * a space when the text has one.
 */
export function wrapForSubtitles(text: string, maxChars: number, maxLines = 3): string {
  const cleaned = text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;

  const rows: string[] = [];
  let rest = cleaned;

  while (rest.length > maxChars && rows.length < maxLines - 1) {
    const window = rest.slice(0, maxChars + 1);
    const lastSpace = window.lastIndexOf(' ');
    const cut = lastSpace > maxChars * 0.5 ? lastSpace : maxChars;
    rows.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) rows.push(rest);

  return rows.filter(Boolean).join('\\N');
}

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

  /** ASS uses H:MM:SS.cc — centiseconds, and no leading zero on the hour. */
  public static formatAssTime(seconds: number): string {
    const totalCs = Math.max(0, Math.round(seconds * 100));
    const hours = Math.floor(totalCs / 360000);
    const mins = Math.floor((totalCs % 360000) / 6000);
    const secs = Math.floor((totalCs % 6000) / 100);
    const cs = totalCs % 100;

    const pad = (n: number, z = 2) => String(n).padStart(z, '0');
    return `${hours}:${pad(mins)}:${pad(secs)}.${pad(cs)}`;
  }

  /**
   * Generate SRT format subtitles matching Khmer dialogue
   */
  public static generateSrt(segments: DialogueSegment[]): string {
    const lines: string[] = [];
    let count = 1;

    for (const seg of segments) {
      const text = subtitleText(seg);
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
      const text = subtitleText(seg);
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
   * Generate the ASS script that is painted onto the video.
   *
   * SRT has no styling and no Khmer font, so burning it directly means empty
   * boxes on most hosts. An ASS script instead names the bundled Khmer font,
   * sizes the text from the real frame height and keeps the timing, which is
   * what makes the Khmer readable in the downloaded MP4. Timings follow the
   * dialogue, so the text appears on the line as the dub speaks it.
   */
  public static generateAss(
    segments: DialogueSegment[],
    videoWidth?: number,
    videoHeight?: number
  ): string {
    const width = Math.max(320, Math.round(videoWidth || 1280));
    const height = Math.max(240, Math.round(videoHeight || 720));

    const fontSize = Math.max(16, Math.round(height * 0.045));
    const marginV = Math.round(height * 0.055);
    const marginH = Math.round(width * 0.045);
    const outline = Math.max(2, Math.round(fontSize * 0.07));
    const shadow = Math.max(1, Math.round(fontSize * 0.04));
    const maxChars = Math.max(16, Math.floor((width - marginH * 2) / (fontSize * 0.95)));

    const usable = [...segments]
      .filter((seg) => subtitleText(seg) && Number.isFinite(seg.start))
      .sort((a, b) => a.start - b.start);

    const events: string[] = [];
    usable.forEach((seg, index) => {
      const next = usable[index + 1];
      const start = Math.max(0, seg.start);
      // A line should stay on screen long enough to be read, but never run into
      // the next one.
      let end = Math.max(seg.end, start + 0.8);
      if (next && Number.isFinite(next.start)) {
        end = Math.min(end, Math.max(start + 0.4, next.start - 0.02));
      }
      const text = wrapForSubtitles(subtitleText(seg), maxChars);
      if (!text) return;

      events.push(
        `Dialogue: 0,${this.formatAssTime(start)},${this.formatAssTime(end)},KhmerDub,,0,0,0,,${text}`
      );
    });

    const header = [
      '[Script Info]',
      '; KhmerDub AI — Khmer subtitles burned into the video',
      'ScriptType: v4.00+',
      'WrapStyle: 0',
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      // Bold, white, black outline, bottom-centred — legible over any footage.
      `Style: KhmerDub,Noto Sans Khmer,${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginH},${marginH},${marginV},1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      '',
    ];

    return `${header.join('\n')}${events.join('\n')}\n`;
  }

  /**
   * Write the ASS script for a job next to its other working files.
   * Returns `null` when there is no line worth showing.
   */
  public static writeAssFile(
    segments: DialogueSegment[],
    destinationPath: string,
    videoWidth?: number,
    videoHeight?: number
  ): string | null {
    if (!segments.some((seg) => subtitleText(seg))) return null;
    const content = this.generateAss(segments, videoWidth, videoHeight);
    fs.writeFileSync(destinationPath, content, 'utf8');
    logger.info(`Wrote ${segments.length} subtitle line(s) for burn-in: ${destinationPath}`);
    return destinationPath;
  }

  /**
   * Render final H.264 / AAC MP4 video with new mixed audio
   */
  public static async renderMp4(
    originalVideoPath: string,
    mixedAudioPath: string,
    outputMp4Path: string,
    settings: JobSettings,
    /** Reported while the MP4 is written, so a slow host still shows movement. */
    onProgress?: (writtenSeconds: number) => void,
    /** ASS script painted onto the picture; omitted when subtitles are off. */
    subtitleAssPath?: string
  ): Promise<string> {
    logger.info(
      subtitleAssPath
        ? `Rendering final MP4 with burned-in Khmer subtitles: ${outputMp4Path}`
        : `Rendering final MP4: ${outputMp4Path}`
    );
    return await FFmpegHelper.renderFinalMp4(
      originalVideoPath,
      mixedAudioPath,
      outputMp4Path,
      settings.outputQuality || 'original',
      onProgress,
      subtitleAssPath
    );
  }
}
