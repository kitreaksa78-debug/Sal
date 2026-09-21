import React from 'react';

/**
 * The KhmerDub mark: a video frame holding a play button, with a pencil crossing
 * its top-right corner — "translate the video, then re-edit it".
 *
 * Drawn inline (no image request) so the cyan → blue → purple gradient stays
 * crisp at any size and the gap where the pencil crosses the frame is exact:
 * the pencil carries a dark outline painted *under* its fill, which cuts the
 * frame's stroke the same way the reference artwork does.
 */
export const Logo: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <defs>
      <linearGradient
        id="khmerdub-mark"
        x1="2"
        y1="22"
        x2="22"
        y2="2"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#22d3ee" />
        <stop offset="0.5" stopColor="#3b82f6" />
        <stop offset="1" stopColor="#a855f7" />
      </linearGradient>
    </defs>

    {/* Video frame */}
    <rect
      x="2.6"
      y="5.6"
      width="18.8"
      height="12.8"
      rx="3.6"
      fill="none"
      stroke="url(#khmerdub-mark)"
      strokeWidth="2"
    />

    {/* Play button */}
    <path d="M7.4 8.7 12.2 12l-4.8 3.3z" fill="url(#khmerdub-mark)" />

    {/* Pencil: tip inside the frame, body running out past its top-right corner */}
    <path
      d="M9.6 17.4 12.43 16.83 22.47 6.79 20.21 4.53 10.17 14.57Z"
      fill="url(#khmerdub-mark)"
      stroke="#0b0f17"
      strokeWidth="1.5"
      strokeLinejoin="round"
      paintOrder="stroke"
    />
  </svg>
);
