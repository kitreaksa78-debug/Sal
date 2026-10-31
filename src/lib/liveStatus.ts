import { useEffect, useState } from 'react';
import { getLiveStatus, LiveStatusView } from './api';

/**
 * One poll of `/api/config/live`, shared by every badge on the page.
 *
 * The header badge and the two cards ask the same question, so they read the
 * same answer: a module-level store with a single timer means three components
 * cost one probe, and a card saved a second ago is reflected everywhere at once.
 *
 * The interval is a poll, not a websocket, on purpose: the thing being watched
 * is a Colab tunnel that changes hostname, not a value the site controls.
 */
const POLL_MS = 20_000;

export interface LiveStatusState {
  data: LiveStatusView | null;
  error: string | null;
  checking: boolean;
  checkedAt: number;
}

let state: LiveStatusState = { data: null, error: null, checking: true, checkedAt: 0 };
const listeners = new Set<(next: LiveStatusState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function publish(patch: Partial<LiveStatusState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener(state));
}

/** Ask the site again now — used after a save and by the badge's click. */
export async function refreshLiveStatus(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  publish({ checking: true });
  try {
    publish({ data: await getLiveStatus(), error: null, checking: false, checkedAt: Date.now() });
  } catch (err: any) {
    // The probe endpoint itself failing means the site is unreachable from this
    // browser — not that the Colab API is down. The badge says which.
    publish({
      error: err?.message || 'មិនអាចពិនិត្យការតភ្ជាប់បានទេ។',
      checking: false,
      checkedAt: Date.now(),
    });
  } finally {
    inFlight = false;
  }
}

function poll() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  void refreshLiveStatus();
}

function startPolling() {
  if (timer !== null) return;
  timer = setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('focus', poll);
  void refreshLiveStatus();
}

export function useLiveStatus(): LiveStatusState & { refresh: () => void } {
  const [snapshot, setSnapshot] = useState<LiveStatusState>(state);

  useEffect(() => {
    const listener = (next: LiveStatusState) => setSnapshot(next);
    listeners.add(listener);
    startPolling();
    // The first fetch may have finished between render and this effect.
    setSnapshot(state);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { ...snapshot, refresh: () => void refreshLiveStatus() };
}

export type BadgeTone = 'ok' | 'warn' | 'error' | 'idle';

export const BADGE_TONE: Record<BadgeTone, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  error: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
  idle: 'bg-slate-800/60 text-slate-400 border-slate-700',
};

export const BADGE_DOT: Record<BadgeTone, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  error: 'bg-rose-400',
  idle: 'bg-slate-500',
};

/**
 * What one card's badge should say.
 *
 * Never trusts the saved URL alone — a Colab tunnel outlives its session by
 * hours, and "ភ្ជាប់រួច" on a dead one is worse than no badge at all.
 */
export function studioCardStatus(
  state: LiveStatusState,
  options: { hasUrl: boolean; configuredInProcess: boolean; kind: 'stems' | 'voice' }
): { tone: BadgeTone; label: string; hint: string } {
  if (options.configuredInProcess) {
    return {
      tone: 'ok',
      label: 'ភ្ជាប់រួច',
      hint: 'កំពុងដំណើរការក្នុងម៉ាស៊ីនរបស់សាយនេះ (no tunnel needed)។',
    };
  }

  if (!options.hasUrl) {
    return {
      tone: 'idle',
      label: 'មិនទាន់ភ្ជាប់',
      hint: 'មិនទាន់បានដាក់ URL — រត់ cell ក្នុង Colab ម្តងទៀត ឬ paste URL នៅក្នុងកាតនេះ។',
    };
  }

  const data = state.data;
  if (!data) {
    return state.checking
      ? { tone: 'warn', label: 'កំពុងពិនិត្យ…', hint: 'កំពុងសួរសេវា — មួយវិនាទី។' }
      : {
          tone: 'warn',
          label: 'មិនអាចពិនិត្យបាន',
          hint: state.error || 'មិនអាចពិនិត្យការតភ្ជាប់បានទេ។',
        };
  }

  const up = options.kind === 'stems' ? data.stems : data.voice;
  return up
    ? { tone: 'ok', label: 'ភ្ជាប់រួច', hint: data.message }
    : { tone: 'error', label: 'មិនឆ្លើយតប', hint: data.message };
}
