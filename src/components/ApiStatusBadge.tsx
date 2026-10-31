import React from 'react';
import { RefreshCw } from 'lucide-react';
import { BADGE_DOT, BADGE_TONE, BadgeTone, useLiveStatus } from '../lib/liveStatus';

/**
 * The one sign the owner asked for: a dot that is green only while the Colab
 * studio actually answers.
 *
 * It lives in the header, so it is on screen in both tabs and while a job is
 * running — the moment the session dies the dot turns red, instead of the news
 * arriving as a failed six-minute separation. Clicking it asks again now.
 */
export const ApiStatusBadge: React.FC<{ className?: string }> = ({ className = '' }) => {
  const live = useLiveStatus();
  const data = live.data;

  const tone: BadgeTone = data ? (data.stems ? 'ok' : 'error') : 'warn';
  const label = data
    ? data.stems
      ? data.voice
        ? 'API ភ្ជាប់រួច'
        : 'ភ្ជាប់តែញែកសំឡេង'
      : 'API មិនទាន់ភ្ជាប់'
    : live.checking
      ? 'កំពុងពិនិត្យ…'
      : 'មិនអាចពិនិត្យបាន';

  const detail = data?.message || live.error || 'កំពុងពិនិត្យការតភ្ជាប់ទៅ API…';

  return (
    <button
      type="button"
      onClick={live.refresh}
      title={`${label} — ${detail}\n(ចុចដើម្បីពិនិត្យម្តងទៀត)`}
      aria-label={`${label} — ${detail}`}
      className={`shrink-0 inline-flex items-center gap-1.5 min-h-[32px] px-2.5 rounded-full border text-[10px] font-bold transition-colors ${BADGE_TONE[tone]} ${className}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${BADGE_DOT[tone]} ${tone === 'ok' ? 'animate-pulse' : ''}`}
      />
      <span className="whitespace-nowrap">{label}</span>
      {data?.stems && data.latencyMs ? (
        <span className="hidden sm:inline opacity-70 font-medium">· {data.latencyMs} ms</span>
      ) : null}
      <RefreshCw className={`w-3 h-3 opacity-70 ${live.checking ? 'animate-spin' : ''}`} />
    </button>
  );
};

export default ApiStatusBadge;
