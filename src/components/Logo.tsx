import React from 'react';

/**
 * The KhmerDub mark: a video tile with a play button, two arrows orbiting it, and
 * a Khmer bubble beside a Chinese one — "take the video, change its language".
 *
 * Drawn inline rather than shipped as an image for two reasons: the gradient
 * stays crisp at every size (the studio is used on phones with high-density
 * screens), and the two bubbles carry real text, so they have to be script the
 * browser renders instead of pixels baked at one resolution.
 *
 * Coordinates live in a 64×64 space; the tile and both bubbles are painted
 * before the arrows, so an arrowhead always reads on top of the shape it points
 * at. The mark itself is transparent — the caller supplies the dark plate it
 * sits on, which is also what the icons in `public/` are generated from.
 */
export const Logo: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 64 64" className={`select-none ${className ?? ''}`} aria-hidden="true">
    <defs>
      <linearGradient id="khmerdub-tile" x1="6" y1="43" x2="35" y2="15" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#22d3ee" />
        <stop offset="0.45" stopColor="#3b82f6" />
        <stop offset="1" stopColor="#7c3aed" />
      </linearGradient>
      <linearGradient id="khmerdub-arrow-up" x1="4" y1="27" x2="39" y2="9" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#38bdf8" />
        <stop offset="0.5" stopColor="#c026d3" />
        <stop offset="1" stopColor="#e879f9" />
      </linearGradient>
      <linearGradient id="khmerdub-arrow-down" x1="5" y1="44" x2="39" y2="58" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#22d3ee" />
        <stop offset="1" stopColor="#3b82f6" />
      </linearGradient>
      <linearGradient id="khmerdub-bubble-khmer" x1="35" y1="22" x2="58" y2="5" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#0ea5e9" />
        <stop offset="1" stopColor="#38bdf8" />
      </linearGradient>
      <linearGradient id="khmerdub-bubble-cjk" x1="38" y1="53" x2="59" y2="37" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#7c3aed" />
        <stop offset="0.55" stopColor="#a855f7" />
        <stop offset="1" stopColor="#d946ef" />
      </linearGradient>
    </defs>

    {/* --- Speech bubbles, so the arrows land on top of them ---------------- */}
    {/* Khmer bubble: tail drops back down towards the tile */}
    <g>
      <path d="M44 21.6 41.1 27.4 48.6 21.6Z" fill="url(#khmerdub-bubble-khmer)" />
      <rect x="35" y="5.5" width="23" height="16.5" rx="6" fill="url(#khmerdub-bubble-khmer)" />
      <text
        x="46.5"
        y="17.2"
        textAnchor="middle"
        fontSize="9.4"
        fontWeight="700"
        fill="#f8fafc"
        fontFamily="'Noto Sans Khmer', 'Khmer OS', 'Leelawadee UI', 'Noto Sans', sans-serif"
      >
        ខ្មែរ
      </text>
    </g>

    {/* Chinese bubble: tail points up towards the tile */}
    <g>
      <path d="M43.4 38.2 40.2 32.7 48.2 38.2Z" fill="url(#khmerdub-bubble-cjk)" />
      <rect x="38" y="37.5" width="21.5" height="15.5" rx="6" fill="url(#khmerdub-bubble-cjk)" />
      <text
        x="48.75"
        y="49.3"
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill="#f8fafc"
        fontFamily="'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans', sans-serif"
      >
        文
      </text>
    </g>

    {/* --- The video tile --------------------------------------------------- */}
    <rect x="5.5" y="15.5" width="29" height="27" rx="6.5" fill="url(#khmerdub-tile)" />
    {/* Spool holes punched through the film strip */}
    <g fill="#0b0f17">
      <rect x="9" y="20.4" width="3.4" height="3.8" rx="1.1" />
      <rect x="9" y="27.6" width="3.4" height="3.8" rx="1.1" />
      <rect x="9" y="34.8" width="3.4" height="3.8" rx="1.1" />
    </g>
    {/* Play button — the stroke rounds the corners of the triangle */}
    <path
      d="M20.4 24.1 30.8 29 20.4 33.9Z"
      fill="#f8fafc"
      stroke="#f8fafc"
      strokeWidth="2.2"
      strokeLinejoin="round"
    />

    {/* --- The two orbit arrows -------------------------------------------- */}
    {/* Over the top, ending at the Khmer bubble */}
    <g>
      <path
        d="M4.8 25.65A21.5 21.5 0 0 1 32.35 12.8"
        fill="none"
        stroke="url(#khmerdub-arrow-up)"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
      <path d="M38.55 15.06 30.91 16.75 33.79 8.85Z" fill="#e879f9" />
    </g>
    {/* Underneath, ending at the Chinese bubble */}
    <g>
      <path
        d="M6.38 43.75A21.5 21.5 0 0 0 32.35 53.2"
        fill="none"
        stroke="url(#khmerdub-arrow-down)"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
      <path d="M38.35 51 33.85 57.3 30.85 49.1Z" fill="#3b82f6" />
    </g>

    {/* --- Speech ticks beside each bubble ---------------------------------- */}
    <g stroke="#38bdf8" strokeWidth="1.9" strokeLinecap="round">
      <path d="M60.2 11 63.4 8.8" />
      <path d="M60.8 14.8H63.8" />
      <path d="M60.2 18.6 63.4 20.8" />
    </g>
    <g stroke="#c026d3" strokeWidth="1.9" strokeLinecap="round">
      <path d="M60.2 41.4 63.4 39.2" />
      <path d="M60.8 45.2H63.8" />
      <path d="M60.2 49 63.4 51.2" />
    </g>
  </svg>
);
