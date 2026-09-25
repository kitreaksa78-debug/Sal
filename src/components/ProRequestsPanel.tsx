import React, { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  ChevronDown,
  Clock3,
  CreditCard,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import {
  decideProRequest,
  getProReceiptUrl,
  listProRequests,
  type ProPaymentRequest,
} from '../lib/api';

interface ProRequestsPanelProps {
  /** Only the app owner sees this: approving a payment grants Pro. */
  visible: boolean;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('km-KH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The owner's payment desk.
 *
 * Every QR payment arrives here as a receipt the customer uploaded. Opening the
 * receipt and pressing Approve is what gives the account Pro — the decision, the
 * note and the moment are all kept so the same receipt is never approved twice.
 */
export const ProRequestsPanel: React.FC<ProRequestsPanelProps> = ({ visible }) => {
  const [requests, setRequests] = useState<ProPaymentRequest[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proDays, setProDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listProRequests();
      setRequests(data.requests);
      setProDays(data.proDays);
    } catch (err: any) {
      setError(err?.message || 'មិនអាចអានការបង់ប្រាក់បានទេ។');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  if (!visible) return null;

  const pending = requests.filter((r) => r.status === 'pending');

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    const request = requests.find((r) => r.id === id);
    const note =
      decision === 'approve'
        ? ''
        : window.prompt('ហេតុផលបដិសេធ (បាន។)៖', request?.reviewNote || '') ?? '';
    setBusyId(id);
    setError(null);
    try {
      await decideProRequest(id, decision, note);
      await load();
    } catch (err: any) {
      setError(err?.message || 'មិនអាចរក្សាទុកការសម្រេចបានទេ។');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800/90 bg-[#111827]/80 shadow-xl backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-slate-900/40 sm:p-5"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/15 text-amber-300">
          <CreditCard className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-white sm:text-base">ការបង់ប្រាក់ Pro</h3>
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
              ADMIN
            </span>
            {pending.length > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                {pending.length} កំពុងរង់ចាំ
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs text-slate-400">
            ពិនិត្យវិក្កយបត្រ QR រួចបើក Pro {proDays} ថ្ងៃដល់អ្នកបង់
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-800/80 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-slate-400">
              ចុច «បើក Pro» បន្ទាប់ពីបានពិនិត្យប្រាក់ក្នុងធនាគារហើយ — គណនីនោះនឹងបើកភ្លាម។
            </p>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              aria-label="ផ្ទុកឡើងវិញ"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-800 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200 disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </button>
          </div>

          {error && <p className="text-[11px] text-rose-300">{error}</p>}

          {requests.length === 0 && (
            <p className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-center text-xs text-slate-400">
              មិនទាន់មានការបង់ប្រាក់តាម QR នៅឡើយ។
            </p>
          )}

          {requests.map((request) => {
            const busy = busyId === request.id;
            return (
              <div
                key={request.id}
                className="space-y-2.5 rounded-xl border border-slate-800 bg-slate-900/50 p-3.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{request.email}</p>
                    <p className="text-[11px] text-slate-400">
                      ${request.amount}
                      {request.transactionRef ? ` · ${request.transactionRef}` : ''} ·{' '}
                      {formatWhen(request.submittedAt)}
                    </p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      request.status === 'pending'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        : request.status === 'approved'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                    }`}
                  >
                    {request.status === 'pending' ? (
                      <Clock3 className="h-3 w-3" />
                    ) : request.status === 'approved' ? (
                      <BadgeCheck className="h-3 w-3" />
                    ) : (
                      <XCircle className="h-3 w-3" />
                    )}
                    {request.status === 'pending'
                      ? 'កំពុងរង់ចាំ'
                      : request.status === 'approved'
                        ? 'បានបើក'
                        : 'មិនបានអនុម័ត'}
                  </span>
                </div>

                {request.note && (
                  <p className="rounded-lg bg-slate-900/70 p-2 text-[11px] text-slate-300">
                    {request.note}
                  </p>
                )}

                <a
                  href={getProReceiptUrl(request.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-800 px-3 text-[11px] font-semibold text-slate-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-200"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  មើលវិក្កយបត្រ
                </a>

                {request.status === 'pending' && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => decide(request.id, 'approve')}
                      disabled={busy}
                      className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/20 px-4 text-xs font-bold text-emerald-200 border border-emerald-500/40 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <BadgeCheck className="h-4 w-4" />
                      )}
                      បើក Pro ({proDays} ថ្ងៃ)
                    </button>
                    <button
                      type="button"
                      onClick={() => decide(request.id, 'reject')}
                      disabled={busy}
                      className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-slate-900/70 px-4 text-xs font-semibold text-slate-300 border border-slate-700 transition-colors hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" />
                      មិនទទួល
                    </button>
                  </div>
                )}

                {request.status === 'approved' && request.proExpiresAt && (
                  <p className="text-[11px] text-emerald-300/90">
                    Pro រហូតដល់ {new Date(request.proExpiresAt).toLocaleDateString('km-KH')}
                  </p>
                )}
                {request.reviewNote && (
                  <p className="text-[11px] text-slate-400">មតិយោបល់៖ {request.reviewNote}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
