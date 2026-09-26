import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * The font libass needs to draw Khmer.
 *
 * Burning Khmer subtitles into the video is only possible with a font that
 * actually carries Khmer glyphs: the hosts this app runs on ship none, so
 * libass would draw empty boxes for every line. The font therefore travels with
 * the repository (`assets/fonts`) and is written to disk once on a host that
 * somehow does not have it, so a render never fails for want of a typeface.
 */
const FONT_FILES = ['NotoSansKhmer-Regular.ttf', 'NotoSansKhmer-Bold.ttf'];

const FONT_CDN =
  'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io@main/fonts/NotoSansKhmer/hinted/ttf';

/** Where a host without the repository copy keeps the fonts it downloaded. */
export function subtitleFontCacheDir(): string {
  return process.env.SUBTITLE_FONTS_DIR || path.join(process.cwd(), 'data', 'fonts');
}

function holdsKhmerFont(dir: string): boolean {
  try {
    return FONT_FILES.some((file) => fs.existsSync(path.join(dir, file)));
  } catch {
    return false;
  }
}

/** Repository copies, in the order they are worth checking. */
function bundledFontDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.SUBTITLE_FONTS_DIR) dirs.push(process.env.SUBTITLE_FONTS_DIR);
  dirs.push(path.join(process.cwd(), 'assets', 'fonts'));
  // The bundled server runs from the repository root, but a host that starts it
  // from `dist/` would otherwise miss the fonts sitting one level up.
  dirs.push(path.join(process.cwd(), '..', 'assets', 'fonts'));
  return dirs;
}

let resolved: string | null | undefined;
let inFlight: Promise<string | null> | null = null;

async function downloadFontsInto(dir: string): Promise<boolean> {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }

  for (const file of FONT_FILES) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) continue;
    try {
      const response = await fetch(`${FONT_CDN}/${file}`);
      if (!response.ok) {
        logger.warn(`Could not download ${file} (${response.status}).`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(target, bytes);
      logger.info(`Downloaded the Khmer subtitle font ${file} (${bytes.length} bytes).`);
    } catch (err) {
      logger.warn(`Could not download ${file}:`, err);
    }
  }

  return holdsKhmerFont(dir);
}

/**
 * The directory libass should scan for the Khmer font, or `null` when none can
 * be found — in which case the caller renders without burned-in subtitles
 * rather than failing the whole job.
 */
export async function resolveSubtitleFontsDir(): Promise<string | null> {
  if (resolved !== undefined) return resolved;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    for (const dir of bundledFontDirs()) {
      if (holdsKhmerFont(dir)) return dir;
    }

    const cacheDir = subtitleFontCacheDir();
    if (await downloadFontsInto(cacheDir)) {
      logger.info(`Khmer subtitle font ready in ${cacheDir}.`);
      return cacheDir;
    }

    logger.warn(
      'No Khmer font is available; the video will be rendered without burned-in subtitles. ' +
        'Add NotoSansKhmer-Regular.ttf to assets/fonts or set SUBTITLE_FONTS_DIR.'
    );
    return null;
  })();

  resolved = await inFlight;
  inFlight = null;
  return resolved;
}
