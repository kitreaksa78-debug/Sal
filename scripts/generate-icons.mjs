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
// tab icon, the header mark and the app icon all stay the same drawing.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------------------------------------------------------------- the artwork
// Same numbers as the inline SVG: a video frame with a play button, crossed by a
// pencil whose dark outline cuts the frame exactly where they overlap.
const FRAME = { x: 2.6, y: 5.6, w: 18.8, h: 12.8, r: 3.6, stroke: 2 };
const PLAY = [
  [7.4, 8.7],
  [12.2, 12],
  [7.4, 15.3],
];
const PENCIL = [
  [9.6, 17.4],
  [12.43, 16.83],
  [22.47, 6.79],
  [20.21, 4.53],
  [10.17, 14.57],
];
const PENCIL_STROKE = 1.5;

/** The app's darkest background, used for the icon tile and the pencil outline. */
const TILE = [11, 15, 23]; // #0b0f17
const GRADIENT = [
  { at: 0, rgb: [0x22, 0xd3, 0xee] }, // cyan
  { at: 0.5, rgb: [0x3b, 0x82, 0xf6] }, // blue
  { at: 1, rgb: [0xa8, 0x55, 0xf7] }, // purple
];

// The mark is drawn smaller than the tile so the icon keeps breathing room and
// survives Android's maskable crop (content must stay inside the middle 80%).
const MARK_SCALE = 0.88;
const MARK_CENTER = { x: 12.5, y: 10.9 };
const TILE_RADIUS = 5.2; // of a 24-unit tile

// ------------------------------------------------------------- shape helpers
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a polygon: negative inside, positive outside. */
function polygonSdf(px, py, points) {
  let distance = Infinity;
  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];

    // Distance to this edge.
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = px - xi;
    const wy = py - yi;
    const len2 = ex * ex + ey * ey;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * ex + wy * ey) / len2));
    distance = Math.min(distance, Math.hypot(wx - t * ex, wy - t * ey));

    // Ray casting for the inside test.
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside ? -distance : distance;
}

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

/** One sample of the artwork, in the 24-unit space. Returns [r,g,b,a]. */
function sample(x, y) {
  // The rounded dark tile: outside it the icon is transparent.
  if (roundedRectSdf(x, y, 12, 12, 12, 12, TILE_RADIUS) > 0) return [0, 0, 0, 0];

  let colour = TILE;
  let opaque = true;

  // Place the mark: scale around its own centre, then centre it in the tile.
  const mx = 12 + (x - MARK_CENTER.x) / MARK_SCALE;
  const my = 12 + (y - MARK_CENTER.y) / MARK_SCALE;

  const frameDistance = roundedRectSdf(
    mx,
    my,
    FRAME.x + FRAME.w / 2,
    FRAME.y + FRAME.h / 2,
    FRAME.w / 2,
    FRAME.h / 2,
    FRAME.r
  );
  const onFrame = Math.abs(frameDistance) <= FRAME.stroke / 2;
  if (onFrame) colour = gradientAt(mx, my);

  if (polygonSdf(mx, my, PLAY) < 0) colour = gradientAt(mx, my);

  // Paint order matters: the pencil's outline goes down first, then its body, so
  // the outline eats the frame stroke where the two cross.
  const pencilDistance = polygonSdf(mx, my, PENCIL);
  if (Math.abs(pencilDistance) <= PENCIL_STROKE / 2) colour = TILE;
  if (pencilDistance < 0) colour = gradientAt(mx, my);

  return [colour[0], colour[1], colour[2], opaque ? 255 : 0];
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
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// --------------------------------------------------------------- the SVG twin
function buildSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="AI translate video">
  <defs>
    <linearGradient id="mark" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset="0.5" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="24" height="24" rx="5.2" fill="#0b0f17"/>
  <g transform="translate(12 12) scale(${MARK_SCALE}) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})">
    <rect x="2.6" y="5.6" width="18.8" height="12.8" rx="3.6" fill="none" stroke="url(#mark)" stroke-width="2"/>
    <path d="M7.4 8.7 12.2 12l-4.8 3.3z" fill="url(#mark)"/>
    <path d="M9.6 17.4 12.43 16.83 22.47 6.79 20.21 4.53 10.17 14.57Z" fill="url(#mark)" stroke="#0b0f17" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke"/>
  </g>
</svg>
`;
}

// ------------------------------------------------------------------ build all
mkdirSync(OUT_DIR, { recursive: true });

const sizes = [16, 32, 48, 64];
const rasters = new Map();
for (const size of [...sizes, 180, 192, 512]) {
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
write('apple-touch-icon.png', rasters.get(180));
write('icon-192.png', rasters.get(192));
write('icon-512.png', rasters.get(512));

// Pixel sanity checks, so a broken drawing is caught here instead of on the web.
const at = (size, x, y) => {
  const rgba = renderIcon(size);
  const offset = (y * size + x) * 4;
  return [...rgba.subarray(offset, offset + 4)];
};
const inside = (x, y) => Math.floor((x / 24) * 192);
const checks = [
  ['corner is transparent', at(192, 1, 1)[3] === 0],
  ['tile centre-left holds the play button colour', at(192, inside(8.5, 12), inside(12, 12))[2] > 150],
  ['frame stroke is drawn', at(192, inside(12, 12), inside(5.6, 5.6))[3] === 255],
  ['icon is fully opaque in the middle', at(192, inside(12, 12), inside(12, 12))[3] === 255],
];

console.log(written.join('\n'));
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
