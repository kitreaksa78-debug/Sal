// Icon generator — draws the app's logo mark into real image files.
//
// The site's mark lives in `src/components/Logo.tsx` as an inline SVG. Browsers
// want a favicon, iOS wants a 180px PNG, Android wants 192/512px PNGs plus a
// manifest, and older browsers still ask for `favicon.ico`. Rather than pull in a
// native image library (sharp/canvas need a compiler and a big download), this
// script rasterises the same geometry itself: signed-distance shapes sampled with
// 4x supersampling, then encoded straight to PNG with Node's own zlib.
//
// Run with: node scripts/generate-icons.mjs
//
// The geometry below is a copy of Logo.tsx in its 24x24 coordinate space, so the
// tab icon, the header mark and the app icon all stay the same drawing: a row of
// rounded waveform bars over a microphone.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------------------------------------------------------------- the artwork
// Same numbers as the inline SVG: a row of rounded waveform bars over a
// microphone — yoke, stem and base — all filled with one indigo.
const BARS = [
  { x: 4.2, height: 3.2 },
  { x: 6.8, height: 5.6 },
  { x: 9.4, height: 7.4 },
  { x: 12, height: 8.8 },
  { x: 14.6, height: 7.4 },
  { x: 17.2, height: 5.6 },
  { x: 19.8, height: 3.2 },
];
const BAR_WIDTH = 1.6;
/** The row's centre line: every bar keeps this and grows both ways. */
const BAR_MIDLINE = 7;
/** The mic yoke: one cubic curve, stroked, so its ends come out round. */
const ARC = {
  from: [4.4, 13.2],
  controlA: [6.5, 17.6],
  controlB: [17.5, 17.6],
  to: [19.6, 13.2],
  stroke: 2,
};
const STEM = { from: [12, 17.4], to: [12, 19.4], stroke: 2 };
const BASE = { x: 9.2, y: 19.4, w: 5.6, h: 2, r: 1 };

/** The app's darkest background, used for the icon tile. */
const TILE = [11, 15, 23]; // #0b0f17
const GRADIENT = [
  { at: 0, rgb: [0x63, 0x66, 0xf1] }, // indigo-500
  { at: 1, rgb: [0x4f, 0x46, 0xe5] }, // indigo-600
];

// The mark is drawn inside the tile rather than edge to edge, so the icon keeps
// breathing room and survives Android's maskable crop (content must stay inside
// the middle 80%).
const MARK_SCALE = 0.94;
/** Middle of the mark's bounding box (x 3.4–20.6, y 2.6–21.4), so it sits centred. */
const MARK_CENTER = { x: 12, y: 12 };
const TILE_RADIUS = 5.2; // of a 24-unit tile

// ------------------------------------------------------------- shape helpers
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from a point to one line segment. */
function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey));
}

/**
 * Distance to a stroked open curve, sampled into a polyline.
 *
 * A round stroke is exactly "everything within half the stroke of the path", and
 * the ends of a polyline carry round caps for free — which is the shape
 * `stroke-linecap="round"` draws in the SVG.
 */
function distanceToPolyline(px, py, points) {
  let distance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    distance = Math.min(distance, distanceToSegment(px, py, points[i], points[i + 1]));
  }
  return distance;
}

/** Sample one cubic Bézier into a polyline the distance test can walk. */
function cubicPoints({ from, controlA, controlB, to }, steps = 24) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u * u * u * from[0] +
        3 * u * u * t * controlA[0] +
        3 * u * t * t * controlB[0] +
        t * t * t * to[0],
      u * u * u * from[1] +
        3 * u * u * t * controlA[1] +
        3 * u * t * t * controlB[1] +
        t * t * t * to[1],
    ]);
  }
  return points;
}

/** Sampled once: the distance test runs for every subsample of every pixel. */
const ARC_POINTS = cubicPoints(ARC);

function gradientAt(x, y) {
  // Linear gradient running from the bottom-left to the top-right, as in the SVG.
  const t = Math.max(0, Math.min(1, (x - 2 + (22 - y)) / 40));
  for (let i = 1; i < GRADIENT.length; i++) {
    const from = GRADIENT[i - 1];
    const to = GRADIENT[i];
    if (t <= to.at || i === GRADIENT.length - 1) {
      const span = to.at - from.at || 1;
      const k = Math.max(0, Math.min(1, (t - from.at) / span));
      return [
        Math.round(from.rgb[0] + (to.rgb[0] - from.rgb[0]) * k),
        Math.round(from.rgb[1] + (to.rgb[1] - from.rgb[1]) * k),
        Math.round(from.rgb[2] + (to.rgb[2] - from.rgb[2]) * k),
      ];
    }
  }
  return GRADIENT[GRADIENT.length - 1].rgb;
}

/** Where a point of the mark lands on the tile, in the 24-unit space. */
function markToTile(x, y) {
  return {
    x: 12 + (x - MARK_CENTER.x) * MARK_SCALE,
    y: 12 + (y - MARK_CENTER.y) * MARK_SCALE,
  };
}

/** One sample of the artwork, in the 24-unit space. Returns [r,g,b,a]. */
function sample(x, y) {
  // The rounded dark tile: outside it the icon is transparent.
  if (roundedRectSdf(x, y, 12, 12, 12, 12, TILE_RADIUS) > 0) return [0, 0, 0, 0];

  let colour = TILE;

  // Undo the placement, exactly inverting buildSvg()'s
  // `translate(12 12) scale(s) translate(-cx -cy)`: a tile point maps back to
  // the mark by travelling to the tile centre first, then dividing by the scale.
  const mx = MARK_CENTER.x + (x - 12) / MARK_SCALE;
  const my = MARK_CENTER.y + (y - 12) / MARK_SCALE;

  // The sound: rounded bars, tallest in the middle.
  for (const bar of BARS) {
    const halfHeight = bar.height / 2;
    if (
      roundedRectSdf(mx, my, bar.x, BAR_MIDLINE, BAR_WIDTH / 2, halfHeight, BAR_WIDTH / 2) <= 0
    ) {
      colour = gradientAt(mx, my);
    }
  }

  // The mic yoke, then the stem and the pill under it. Half the stroke lies
  // either side of the path, which is what makes the caps round.
  if (distanceToPolyline(mx, my, ARC_POINTS) <= ARC.stroke / 2) colour = gradientAt(mx, my);
  if (distanceToSegment(mx, my, STEM.from, STEM.to) <= STEM.stroke / 2) {
    colour = gradientAt(mx, my);
  }
  if (
    roundedRectSdf(
      mx,
      my,
      BASE.x + BASE.w / 2,
      BASE.y + BASE.h / 2,
      BASE.w / 2,
      BASE.h / 2,
      BASE.r
    ) <= 0
  ) {
    colour = gradientAt(mx, my);
  }

  return [colour[0], colour[1], colour[2], 255];
}

/** Rasterise one square icon with 4x supersampling. */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const sub = 4;
  const perUnit = size / 24;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const unitX = ((px + (sx + 0.5) / sub) / perUnit);
          const unitY = ((py + (sy + 0.5) / sub) / perUnit);
          const [sr, sg, sb, sa] = sample(unitX, unitY);
          const alpha = sa / 255;
          r += sr * alpha;
          g += sg * alpha;
          b += sb * alpha;
          a += sa;
        }
      }

      const samples = sub * sub;
      const alpha = a / samples;
      const offset = (py * size + px) * 4;
      // Un-premultiply so the tile colour stays correct on every background.
      const weight = alpha / 255;
      rgba[offset] = weight > 0 ? Math.round(r / (samples * weight)) : 0;
      rgba[offset + 1] = weight > 0 ? Math.round(g / (samples * weight)) : 0;
      rgba[offset + 2] = weight > 0 ? Math.round(b / (samples * weight)) : 0;
      rgba[offset + 3] = Math.round(alpha);
    }
  }

  return rgba;
}

// -------------------------------------------------------------- PNG encoding
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico container holding PNG images (supported by every browser since IE11). */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// --------------------------------------------------------------- the SVG twin
function buildSvg() {
  const bars = BARS.map(
    (bar) =>
      `    <rect x="${(bar.x - BAR_WIDTH / 2).toFixed(2)}" y="${(
        BAR_MIDLINE -
        bar.height / 2
      ).toFixed(2)}" width="${BAR_WIDTH}" height="${bar.height}" rx="${(
        BAR_WIDTH / 2
      ).toFixed(2)}" fill="url(#mark)"/>`
  ).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="AI translate video">
  <defs>
    <linearGradient id="mark" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#4f46e5"/>
    </linearGradient>
  </defs>
  <rect width="24" height="24" rx="${TILE_RADIUS}" fill="#0b0f17"/>
  <g transform="translate(12 12) scale(${MARK_SCALE}) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})">
${bars}
    <path d="M${ARC.from[0]} ${ARC.from[1]} C${ARC.controlA[0]} ${ARC.controlA[1]} ${ARC.controlB[0]} ${ARC.controlB[1]} ${ARC.to[0]} ${ARC.to[1]}" fill="none" stroke="url(#mark)" stroke-width="${ARC.stroke}" stroke-linecap="round"/>
    <path d="M${STEM.from[0]} ${STEM.from[1]} L${STEM.to[0]} ${STEM.to[1]}" fill="none" stroke="url(#mark)" stroke-width="${STEM.stroke}" stroke-linecap="round"/>
    <rect x="${BASE.x}" y="${BASE.y}" width="${BASE.w}" height="${BASE.h}" rx="${BASE.r}" fill="url(#mark)"/>
  </g>
</svg>
`;
}

// ------------------------------------------------------------------ build all
mkdirSync(OUT_DIR, { recursive: true });

const sizes = [16, 32, 48, 64];
const rasters = new Map();
for (const size of [...sizes, 96, 180, 192, 512]) {
  rasters.set(size, encodePng(size, renderIcon(size)));
}

const written = [];
const write = (name, buffer) => {
  writeFileSync(path.join(OUT_DIR, name), buffer);
  written.push(`${name} (${(buffer.length / 1024).toFixed(1)} KB)`);
};

write('favicon.svg', Buffer.from(buildSvg(), 'utf8'));
write('favicon.ico', encodeIco(sizes.map((size) => ({ size, data: rasters.get(size) }))));
write('favicon-32.png', rasters.get(32));
// 96px is the size Google's search-result crawler prefers; a crisp file at
// exactly /favicon-96x96.png removes its need to upscale the 32px one.
write('icon-96.png', rasters.get(96));
write('apple-touch-icon.png', rasters.get(180));
write('icon-192.png', rasters.get(192));
write('icon-512.png', rasters.get(512));

// ------------------------------------------------------------------ the checks
// Pixel sanity checks, so a broken drawing is caught here instead of on the web.
// Each probe names a point on the *mark* (the 24-unit space the SVG is drawn in)
// and the helper walks it through the same scale/centre transform the renderer
// uses — measuring raw pixel offsets instead is how a check silently ends up
// looking at the middle of the tile no matter which point it was asked about.
const pixelCache = new Map();
function renderOnce(size) {
  if (!pixelCache.has(size)) pixelCache.set(size, renderIcon(size));
  return pixelCache.get(size);
}

function atSize(size, x, y) {
  const rgba = renderOnce(size);
  const perUnit = size / 24;
  const px = Math.min(size - 1, Math.max(0, Math.round(x * perUnit)));
  const py = Math.min(size - 1, Math.max(0, Math.round(y * perUnit)));
  const offset = (py * size + px) * 4;
  return [...rgba.subarray(offset, offset + 4)];
}

/** Colour of one point of the mark, read back from the 192px raster. */
const onMark = (markX, markY) => {
  const { x, y } = markToTile(markX, markY);
  return atSize(192, x, y);
};

const isBright = ([r, , b, a]) => a === 255 && b > 150 && r < 150;
const isTile = ([r, g, b, a]) => a === 255 && r < 50 && g < 60 && b < 80;

const checks = [
  ['corner is transparent', atSize(192, 1, 1)[3] === 0],
  ['centre of the tile is opaque', atSize(192, 12, 12)[3] === 255],
  ['outer waveform bar is drawn', isBright(onMark(4.2, 7))],
  ['tallest waveform bar is drawn', isBright(onMark(12, 3.2))],
  ['mic yoke is drawn', isBright(onMark(12, 16.5))],
  ['mic stem is drawn', isBright(onMark(12, 18.4))],
  ['mic base is drawn', isBright(onMark(12, 20.4))],
  ['tile background stays dark', isTile(onMark(4.2, 18.6))],
];

console.log(written.join('\n'));
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
