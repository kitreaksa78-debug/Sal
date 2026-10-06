import React from 'react';

/**
 * The KhmerDub mark: a microphone under the sound it carries — a row of rounded
 * waveform bars, then the mic yoke, stem and base.
 *
 * Drawn inline (no image request) so it stays crisp at any size. The mark is
 * drawn in its own 24-unit space and then centred in the viewBox with the same
 * `translate / scale / translate` the icon generator applies, so the header mark,
 * the browser tab and the installed app icon are literally one drawing. Keep the
 * numbers here in step with `scripts/generate-icons.mjs`.
 */
const MARK_SCALE = 0.94;
/** Middle of the mark's bounding box (x 3.4–20.6, y 2.6–21.4). */
const MARK_CENTER = { x: 12, y: 12 };

/** Waveform: seven rounded bars, the tallest in the middle. */
const BARS: { x: number; height: number }[] = [
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
const ARC_PATH = 'M4.4 13.2 C6.5 17.6 17.5 17.6 19.6 13.2';
const ARC_STROKE = 2;
/** Stem and base turn the yoke into a microphone instead of a plain smile. */
const STEM_PATH = 'M12 17.4 V19.4';
const STEM_STROKE = 2;
const BASE = { x: 9.2, y: 19.4, w: 5.6, h: 2, r: 1 };

const MARK_TRANSFORM = `translate(12 12) scale(${MARK_SCALE}) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})`;

export const Logo: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={`select-none ${className ?? ''}`} aria-hidden="true">
    <defs>
      <linearGradient
        id="khmerdub-mark"
        x1="2"
        y1="22"
        x2="22"
        y2="2"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#6366f1" />
        <stop offset="1" stopColor="#4f46e5" />
      </linearGradient>
    </defs>

    <g transform={MARK_TRANSFORM}>
      {/* The sound: one rounded bar per column, symmetric around the middle. */}
      {BARS.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x - BAR_WIDTH / 2}
          y={BAR_MIDLINE - bar.height / 2}
          width={BAR_WIDTH}
          height={bar.height}
          rx={BAR_WIDTH / 2}
          fill="url(#khmerdub-mark)"
        />
      ))}

      <path
        d={ARC_PATH}
        fill="none"
        stroke="url(#khmerdub-mark)"
        strokeWidth={ARC_STROKE}
        strokeLinecap="round"
      />
      <path
        d={STEM_PATH}
        fill="none"
        stroke="url(#khmerdub-mark)"
        strokeWidth={STEM_STROKE}
        strokeLinecap="round"
      />
      <rect
        x={BASE.x}
        y={BASE.y}
        width={BASE.w}
        height={BASE.h}
        rx={BASE.r}
        fill="url(#khmerdub-mark)"
      />
    </g>
  </svg>
);
