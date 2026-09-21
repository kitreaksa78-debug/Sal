import React, { useEffect, useState } from 'react';
import {
  History,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowRight,
  Download,
  Trash2,
  Loader2,
} from 'lucide-react';
import { JobRecord } from '../types';
import { listJobs, getDownloadUrl, deleteJob, deleteAllJobs } from '../lib/api';
import { getSignedInUser } from '../lib/auth';

interface JobHistoryProps {
  onSelectJob: (job: JobRecord) => void;
}

export const JobHistory: React.FC<JobHistoryProps> = ({ onSelectJob }) => {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  // Each account sees only its own uploads — the server filters by session.
  const account = getSignedInUser();

  /** A job the pipeline is still writing into must not be deleted out from under it. */
  const isBusy = (job: JobRecord) => job.status !== 'completed' && job.status !== 'failed';

  const fetchJobs = async () => {
    try {
      setLoading(true);
      const data = await listJobs();
      setJobs(data);
    } catch (e) {
      console.error('Failed to load jobs history:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, [account?.id]);

  const removeJob = async (job: JobRecord) => {
    const label = job.originalFilename || job.id;
    if (
      !window.confirm(
        `លុប "${label}" ចេញពីប្រវត្តិ?\n\nឯកសារវីដេអូ សំឡេង និងអក្សររត់របស់ការងារនេះនឹងត្រូវលុបដែរ ហើយយកមកវិញមិនបានទេ។`
      )
    ) {
      return;
    }

    setDeletingId(job.id);
    try {
      await deleteJob(job.id);
      setJobs((prev) => prev.filter((item) => item.id !== job.id));
    } catch (e: any) {
      alert(e?.message || 'មិនអាចលុបការងារនេះបានទេ');
    } finally {
      setDeletingId(null);
    }
  };

  const clearHistory = async () => {
    const finished = jobs.filter((job) => !isBusy(job));
    if (finished.length === 0) return;
    if (
      !window.confirm(
        `លុបប្រវត្តិទាំង ${finished.length} ការងារ?\n\nឯកសារទាំងអស់នឹងត្រូវលុប ហើយយកមកវិញមិនបានទេ។ ការងារដែលកំពុងដំណើរការនឹងមិនត្រូវប៉ះពាល់ទេ។`
      )
    ) {
      return;
    }

    setClearing(true);
    try {
      await deleteAllJobs();
      setJobs((prev) => prev.filter((job) => isBusy(job)));
    } catch (e: any) {
      alert(e?.message || 'មិនអាចសម្អាតប្រវត្តិបានទេ');
    } finally {
      setClearing(false);
    }
  };

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString('km-KH', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoStr;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 border-b border-slate-800 pb-4">
        <div className="min-w-0">
          <h2 className="text-base sm:text-xl font-bold text-white flex items-start gap-2">
            <History className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <span>ប្រវត្តិការងារបញ្ចូលសំឡេង (Dubbing History)</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1">
            បញ្ជីរាយនាមវីដេអូដែលបានដំណើរការកន្លងមក
            {account && (
              <>
                {' '}
                — ជាកម្មសិទ្ធិរបស់គណនី <span className="text-emerald-300">{account.email}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
          <button
            type="button"
            onClick={fetchJobs}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors min-h-[40px]"
          >
            ផ្ទុកឡើងវិញ (Refresh)
          </button>

          {/* Clearing keeps anything still processing — see the server rule. */}
          {jobs.some((job) => !isBusy(job)) && (
            <button
              type="button"
              onClick={clearHistory}
              disabled={clearing || deletingId !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/25 text-xs font-medium transition-colors min-h-[40px] disabled:opacity-50 disabled:cursor-wait"
            >
              {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              <span>លុបទាំងអស់</span>
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 sm:py-16 text-slate-300 text-sm">
          កំពុងផ្ទុកប្រវត្តិការងារ...
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 sm:py-16 px-4 bg-[#111827]/40 rounded-2xl border border-slate-800 space-y-3">
          <History className="w-10 h-10 text-slate-400 mx-auto" />
          <h4 className="text-base font-semibold text-slate-300">មិនទាន់មានប្រវត្តិការងារនៅឡើយទេ</h4>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            គណនីនេះមិនទាន់មានវីដេអូទេ។ សូមត្រឡប់ទៅផ្ទាំង "ស្ទូឌីយោ" ដើម្បីបញ្ចូលវីដេអូដំបូងរបស់អ្នក
          </p>
        </div>
      ) : (
        <div className="grid gap-3.5">
          {jobs.map((job) => {
            const isCompleted = job.status === 'completed';
            const isFailed = job.status === 'failed';

            return (
              <div
                key={job.id}
                className="p-4 rounded-xl bg-[#111827]/80 hover:bg-[#111827] border border-slate-800 hover:border-emerald-500/40 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-md"
              >
                <div className="flex items-start sm:items-center gap-3 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      isCompleted
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : isFailed
                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        : 'bg-teal-500/20 text-teal-400 border border-teal-500/30'
                    }`}
                  >
                    {isCompleted && <CheckCircle2 className="w-5 h-5" />}
                    {isFailed && <AlertCircle className="w-5 h-5" />}
                    {!isCompleted && !isFailed && <Clock className="w-5 h-5 animate-spin" />}
                  </div>

                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-white truncate max-w-[70vw] sm:max-w-md">
                      {job.originalFilename || `Video-${job.id}`}
                    </h4>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 mt-0.5">
                      <span>{formatDate(job.createdAt)}</span>
                      <span>•</span>
                      <span className="capitalize">{job.settings?.voiceStyle || 'natural'}</span>
                      {job.metadata?.duration && (
                        <>
                          <span>•</span>
                          <span>{Math.round(job.metadata.duration)} វិនាទី</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                  {isCompleted && (
                    <a
                      href={getDownloadUrl(job.id)}
                      download
                      className="p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors shrink-0"
                      title="ទាញយក MP4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  )}

                  <button
                    type="button"
                    onClick={() => removeJob(job)}
                    disabled={isBusy(job) || deletingId === job.id || clearing}
                    title={
                      isBusy(job)
                        ? 'កំពុងដំណើរការ — លុបមិនបានទេ'
                        : 'លុបចេញពីប្រវត្តិ (រួមទាំងឯកសារ)'
                    }
                    className="p-2.5 rounded-xl bg-slate-800/80 text-slate-400 border border-slate-700 hover:bg-rose-500/15 hover:text-rose-300 hover:border-rose-500/30 transition-colors shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {deletingId === job.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => onSelectJob(job)}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition-all min-h-[44px]"
                  >
                    <span>{isCompleted ? 'មើលលទ្ធផល' : 'មើលវឌ្ឍនភាព'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
