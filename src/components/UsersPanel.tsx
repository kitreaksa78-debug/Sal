import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw, Search, Users } from 'lucide-react';
import { listUsers, type SignedInUser } from '../lib/api';

interface UsersPanelProps {
  /** Only the app owner sees this: the full list is never shown to anyone else. */
  visible: boolean;
}

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('km-KH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDay(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('km-KH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Manual Pro that has not run out yet — anything else is the free tier. */
function isPro(user: SignedInUser): boolean {
  if (user.plan !== 'pro') return false;
  return !user.proExpiresAt || new Date(user.proExpiresAt).getTime() > Date.now();
}

/**
 * The owner's account list.
 *
 * Every Google account that has signed into the site appears here, newest
 * login first — name, email, how often it came back, when it was last seen and
 * which plan it is on. The server answers the whole list only for the app
 * owner (`scope: 'all'`); for anyone else this would show just their own
 * record, and the card is hidden for them anyway.
 */
export const UsersPanel: React.FC<UsersPanelProps> = ({ visible }) => {
  const [users, setUsers] = useState<SignedInUser[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listUsers(500);
      setUsers(data.users);
    } catch (err: any) {
      setError(err?.message || 'មិនអាចអានបញ្ជីគណនីបានទេ។');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Preload as soon as the card appears, so the header already knows the
    // count before it is ever opened.
    if (!visible) return;
    void load();
  }, [visible, load]);

  useEffect(() => {
    // Every open asks again: a sign-in that happened since the last look must
    // not be missing from the list the owner just opened.
    if (!visible || !open) return;
    void load();
  }, [visible, open, load]);

  if (!visible) return null;

  const query = filter.trim().toLowerCase();
  const shown = query
    ? users.filter(
        (user) =>
          user.email.toLowerCase().includes(query) ||
          (user.name || '').toLowerCase().includes(query)
      )
    : users;
  const proCount = users.filter(isPro).length;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800/90 bg-[#111827]/80 shadow-xl backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-slate-900/40 sm:p-5"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/15 text-emerald-300">
          <Users className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-white sm:text-base">
              គណនីដែលបានចូល (Users)
            </h3>
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/30">
              ADMIN
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[10px] font-bold text-slate-300">
              {users.length} គណនី
            </span>
            {proCount > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                {proCount} Pro
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs text-slate-400">
            បញ្ជីគណនី Google ដែលបាន login ក្នុងគេហទំព័រនេះ — ថ្មីបំផុតនៅលើគេសិន
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-800/80 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="ស្វែងរកតាមឈ្មោះ ឬអ៊ីមែល..."
                className="w-full rounded-lg border border-slate-700 bg-slate-900/70 pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500/50 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition-colors min-h-[40px] disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              ផ្ទុកឡើងវិញ
            </button>
          </div>

          {error && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {error}
            </p>
          )}

          {loading && users.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">កំពុងផ្ទុកបញ្ជីគណនី...</p>
          ) : shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              {users.length === 0
                ? 'មិនមានគណនីណាបានចូលនៅឡើយទេ។'
                : 'រកមិនឃើញគណនីដែលតម្រង់ត្រូវទេ។'}
            </p>
          ) : (
            <ul className="space-y-2">
              {shown.map((user) => (
                <li
                  key={user.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-[#0b0f17]/80 p-3"
                >
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-9 w-9 rounded-full border border-slate-700 shrink-0"
                    />
                  ) : (
                    <span className="h-9 w-9 rounded-full bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 text-sm font-bold flex items-center justify-center shrink-0">
                      {(user.name || user.email).charAt(0).toUpperCase()}
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-white truncate">
                      {user.name || '—'}
                      <span className="ml-2 text-xs font-normal text-slate-400 truncate">
                        {user.email}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      ចូលលើកដំបូង {formatDay(user.createdAt)} · ចុងក្រោយ {formatWhen(user.lastLoginAt)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                        isPro(user)
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                          : 'border-slate-700 bg-slate-900/70 text-slate-400'
                      }`}
                    >
                      {isPro(user) ? 'Pro' : 'Free'}
                    </span>
                    <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[10px] font-bold text-slate-300">
                      {user.logins || 0} ដង
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
