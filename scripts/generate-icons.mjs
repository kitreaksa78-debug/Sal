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
//
// The same mark as `src/components/Logo.tsx`, scaled from its 64-unit drawing
// by 0.375 and given its own gradients. The two speech bubbles carry real text in
// the SVG twin but none here: at the sizes an icon is seen at, a glyph is three
// pixels of noise, while the plate, the film tile and the two arrows stay legible.
const TILE = [11, 15, 23]; // #0b0f17 — the icon plate and the spool holes
const WHITE = [0xf8, 0xfa, 0xfc];

/** A linear gradient: two points in the 24-unit space plus its colour stops. */
const TILE_GRADIENT = {
  from: [2.25, 16.13],
  to: [13.13, 5.63],
  stops: [
    { at: 0, rgb: [0x22, 0xd3, 0xee] },
    { at: 0.45, rgb: [0x3b, 0x82, 0xf6] },
    { at: 1, rgb: [0x7c, 0x3a, 0xed] },
  ],
};
const ARROW_UP_GRADIENT = {
  from: [1.5, 10.13],
  to: [14.63, 3.38],
  stops: [
    { at: 0, rgb: [0x38, 0xbd, 0xf8] },
    { at: 0.5, rgb: [0xc0, 0x26, 0xd3] },
    { at: 1, rgb: [0xe8, 0x79, 0xf9] },
  ],
};
const ARROW_DOWN_GRADIENT = {
  from: [1.88, 16.5],
  to: [14.63, 21.75],
  stops: [
    { at: 0, rgb: [0x22, 0xd3, 0xee] },
    { at: 1, rgb: [0x3b, 0x82, 0xf6] },
  ],
};
const BUBBLE_KHMER_GRADIENT = {
  from: [13.13, 8.25],
  to: [21.75, 1.88],
  stops: [
    { at: 0, rgb: [0x0e, 0xa5, 0xe9] },
    { at: 1, rgb: [0x38, 0xbd, 0xf8] },
  ],
};
const BUBBLE_CJK_GRADIENT = {
  from: [14.25, 19.88],
  to: [22.13, 13.88],
  stops: [
    { at: 0, rgb: [0x7c, 0x3a, 0xed] },
    { at: 0.55, rgb: [0xa8, 0x55, 0xf7] },
    { at: 1, rgb: [0xd9, 0x46, 0xef] },
  ],
};

// The mark is drawn smaller than the plate so the icon keeps breathing room and
// survives Android's maskable crop (content must stay inside the middle 80%).
const MARK_SCALE = 0.94;
const MARK_CENTER = { x: 11.38, y: 11.78 };
const TILE_RADIUS = 5.2; // of a 24-unit plate

// Everything below is measured from the 24-unit space of the icon, not the 64
// used by the on-page logo.
const ARC = { cx: 9.375, cy: 12.375, radius: 8.0625, halfWidth: 0.86 };
const ARC_UP = { start: 200, end: 290 }; // over the top, clockwise
const ARC_DOWN = { start: 70, end: 150 }; // underneath, counter-clockwise

const VIDEO_TILE = { x: 2.06, y: 5.81, w: 10.88, h: 10.13, r: 2.44 };
const SPOOLS = [7.65, 10.35, 13.05].map((y) => ({
  x: 3.38,
  y,
  w: 1.28,
  h: 1.43,
  r: 0.41,
}));
const PLAY = [
  [7.65, 9.04],
  [11.55, 10.88],
  [7.65, 12.71],
];
const PLAY_ROUND = 0.41; // half the play button's stroke, which rounds its corners

const BUBBLE_KHMER = { x: 13.13, y: 2.06, w: 8.63, h: 6.19, r: 2.25 };
const BUBBLE_KHMER_TAIL = [
  [16.5, 8.1],
  [15.41, 10.28],
  [18.23, 8.1],
];
const BUBBLE_CJK = { x: 14.25, y: 14.06, w: 8.06, h: 5.81, r: 2.25 };
const BUBBLE_CJK_TAIL = [
  [16.28, 14.33],
  [15.08, 12.26],
  [18.08, 14.33],
];

const ARROW_UP_HEAD = [
  [14.46, 5.65],
  [11.59, 6.28],
  [12.67, 3.32],
];
const ARROW_DOWN_HEAD = [
  [14.38, 19.13],
  [12.69, 21.49],
  [11.57, 18.41],
];

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

/**
 * Distance from a point to a thick arc: negative inside the band.
 * `range` is the pair of angles the arc sweeps, in the same degrees the SVG
 * paths use (0° points right, growing clockwise on screen).
 */
function arcBandSdf(px, py, arc, range) {
  const dx = px - arc.cx;
  const dy = py - arc.cy;
  const radial = Math.abs(Math.hypot(dx, dy) - arc.radius) - arc.halfWidth;

  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  if (angle >= range.start && angle <= range.end) return radial;

  // Past either end the nearest point on the arc is that end cap.
  const capDistance = (degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return Math.hypot(
      px - (arc.cx + arc.radius * Math.cos(radians)),
      py - (arc.cy + arc.radius * Math.sin(radians))
    );
  };
  return Math.min(capDistance(range.start), capDistance(range.end)) - arc.halfWidth;
}

/** True when the point sits inside a rounded rectangle of the mark. */
function inRoundedRect(x, y, rect) {
  return (
    roundedRectSdf(x, y, rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2, rect.r) <= 0
  );
}

/** Project a point onto one gradient's axis and read the colour there. */
function gradientAt(x, y, gradient) {
  const [x0, y0] = gradient.from;
  const [x1, y1] = gradient.to;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));

  for (let i = 1; i < gradient.stops.length; i++) {
    const from = gradient.stops[i - 1];
    const to = gradient.stops[i];
    if (t <= to.at || i === gradient.stops.length - 1) {
      const span = to.at - from.at || 1;
      const k = Math.max(0, Math.min(1, (t - from.at) / span));
      return [
        Math.round(from.rgb[0] + (to.rgb[0] - from.rgb[0]) * k),
        Math.round(from.rgb[1] + (to.rgb[1] - from.rgb[1]) * k),
        Math.round(from.rgb[2] + (to.rgb[2] - from.rgb[2]) * k),
      ];
    }
  }
  return gradient.stops[gradient.stops.length - 1].rgb.slice();
}

/** One sample of the artwork, in the 24-unit space. Returns [r,g,b,a]. */
function sample(x, y) {
  // The rounded dark tile: outside it the icon is transparent.
  if (roundedRectSdf(x, y, 12, 12, 12, 12, TILE_RADIUS) > 0) return [0, 0, 0, 0];

  let colour = TILE;

  // Place the mark: scale around its own centre, then centre it in the plate.
  const mx = 12 + (x - MARK_CENTER.x) / MARK_SCALE;
  const my = 12 + (y - MARK_CENTER.y) / MARK_SCALE;

  // Paint order is the SVG's: bubbles, then the film tile, then the arrows, so
  // an arrowhead always lands on top of the shape it points at.
  if (inRoundedRect(mx, my, BUBBLE_KHMER) || polygonSdf(mx, my, BUBBLE_KHMER_TAIL) < 0) {
    colour = gradientAt(mx, my, BUBBLE_KHMER_GRADIENT);
  }
  if (inRoundedRect(mx, my, BUBBLE_CJK) || polygonSdf(mx, my, BUBBLE_CJK_TAIL) < 0) {
    colour = gradientAt(mx, my, BUBBLE_CJK_GRADIENT);
  }

  if (inRoundedRect(mx, my, VIDEO_TILE)) {
    colour = gradientAt(mx, my, TILE_GRADIENT);
    if (SPOOLS.some((spool) => inRoundedRect(mx, my, spool))) colour = TILE;
    if (polygonSdf(mx, my, PLAY) <= PLAY_ROUND) colour = WHITE;
  }

  if (arcBandSdf(mx, my, ARC, ARC_UP) <= 0 || polygonSdf(mx, my, ARROW_UP_HEAD) < 0) {
    colour = gradientAt(mx, my, ARROW_UP_GRADIENT);
  }
  if (arcBandSdf(mx, my, ARC, ARC_DOWN) <= 0 || polygonSdf(mx, my, ARROW_DOWN_HEAD) < 0) {
    colour = gradientAt(mx, my, ARROW_DOWN_GRADIENT);
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
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// --------------------------------------------------------------- the SVG twin
/** `#rrggbb` for one stop, so the SVG and the rasteriser cannot drift apart. */
const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

function buildSvg() {
  const linearGradient = (id, gradient) =>
    `    <linearGradient id="${id}" x1="${gradient.from[0]}" y1="${gradient.from[1]}" x2="${gradient.to[0]}" y2="${gradient.to[1]}" gradientUnits="userSpaceOnUse">\n` +
    gradient.stops
      .map((stop) => `      <stop offset="${stop.at}" stop-color="${hex(stop.rgb)}"/>`)
      .join('\n') +
    '\n    </linearGradient>';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="AI translate video">
  <defs>
${linearGradient('tile', TILE_GRADIENT)}
${linearGradient('arrowUp', ARROW_UP_GRADIENT)}
${linearGradient('arrowDown', ARROW_DOWN_GRADIENT)}
${linearGradient('bubbleKhmer', BUBBLE_KHMER_GRADIENT)}
${linearGradient('bubbleCjk', BUBBLE_CJK_GRADIENT)}
  </defs>
  <rect width="24" height="24" rx="${TILE_RADIUS}" fill="#0b0f17"/>
  <g transform="translate(12 12) scale(${MARK_SCALE}) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})">
    <path d="M16.5 8.1 15.41 10.28 18.23 8.1Z" fill="url(#bubbleKhmer)"/>
    <rect x="13.13" y="2.06" width="8.63" height="6.19" rx="2.25" fill="url(#bubbleKhmer)"/>
    <text x="17.44" y="6.4" text-anchor="middle" font-size="3.5" font-weight="700" fill="#f8fafc" font-family="'Noto Sans Khmer','Khmer OS',sans-serif">ខ្មែរ</text>
    <path d="M16.28 14.33 15.08 12.26 18.08 14.33Z" fill="url(#bubbleCjk)"/>
    <rect x="14.25" y="14.06" width="8.06" height="5.81" rx="2.25" fill="url(#bubbleCjk)"/>
    <text x="18.28" y="18.42" text-anchor="middle" font-size="4.1" font-weight="700" fill="#f8fafc" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif">文</text>
    <rect x="2.06" y="5.81" width="10.88" height="10.13" rx="2.44" fill="url(#tile)"/>
    <g fill="#0b0f17">
      <rect x="3.38" y="7.65" width="1.28" height="1.43" rx="0.41"/>
      <rect x="3.38" y="10.35" width="1.28" height="1.43" rx="0.41"/>
      <rect x="3.38" y="13.05" width="1.28" height="1.43" rx="0.41"/>
    </g>
    <path d="M7.65 9.04 11.55 10.88 7.65 12.71Z" fill="#f8fafc" stroke="#f8fafc" stroke-width="0.83" stroke-linejoin="round"/>
    <path d="M1.8 9.62A8.06 8.06 0 0 1 12.13 4.8" fill="none" stroke="url(#arrowUp)" stroke-width="1.73" stroke-linecap="round"/>
    <path d="M14.46 5.65 11.59 6.28 12.67 3.32Z" fill="#e879f9"/>
    <path d="M2.39 16.41A8.06 8.06 0 0 0 12.13 19.95" fill="none" stroke="url(#arrowDown)" stroke-width="1.73" stroke-linecap="round"/>
    <path d="M14.38 19.13 12.69 21.49 11.57 18.41Z" fill="#3b82f6"/>
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

// Pixel sanity checks, so a broken drawing is caught here instead of on the web.
const at = (size, x, y) => {
  const rgba = renderIcon(size);
  const offset = (y * size + x) * 4;
  return [...rgba.subarray(offset, offset + 4)];
};
/**
 * The pixel a point of the *mark* lands on. The mark is scaled and centred
 * inside the plate, so its own coordinates have to be mapped through the same
 * transform `sample` applies before it looks at them.
 */
const onMark = (markX, markY) => {
  const x = MARK_CENTER.x + (markX - 12) * MARK_SCALE;
  const y = MARK_CENTER.y + (markY - 12) * MARK_SCALE;
  return at(192, Math.floor((x / 24) * 192), Math.floor((y / 24) * 192));
};

const checks = [
  ['corner is transparent', at(192, 1, 1)[3] === 0],
  [
    'the play button is drawn white',
    onMark(8.95, 10.88).slice(0, 3).every((channel) => channel > 200),
  ],
  ['the film tile holds its gradient', onMark(12.2, 8)[2] > 120],
  ['the Khmer bubble is drawn cyan', onMark(17.4, 4.6)[2] > 200 && onMark(17.4, 4.6)[1] > 120],
  ['the Chinese bubble is drawn violet', onMark(18.3, 18.3)[0] > 100],
  [
    'the orbit arrow is drawn blue',
    onMark(6.6, 20.4)[2] > 150 && onMark(6.6, 20.4)[0] < 120,
  ],
  ['the plate is opaque beside the mark', onMark(2, 21.5)[3] === 255],
];

console.log(written.join('\n'));
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
