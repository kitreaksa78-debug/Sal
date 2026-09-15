import React, { useEffect, useState } from 'react';
import { History, CheckCircle2, AlertCircle, Clock, ArrowRight, Play, Download } from 'lucide-react';
import { JobRecord } from '../types';
import { listJobs, getDownloadUrl } from '../lib/api';

interface JobHistoryProps {
  onSelectJob: (job: JobRecord) => void;
}

export const JobHistory: React.FC<JobHistoryProps> = ({ onSelectJob }) => {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(true);

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
  }, []);

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
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <History className="w-5 h-5 text-emerald-400" />
            <span>ប្រវត្តិការងារបញ្ចូលសំឡេង (Dubbing History)</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1">
            បញ្ជីរាយនាមវីដេអូដែលបានដំណើរការកន្លងមក
          </p>
        </div>

        <button
          type="button"
          onClick={fetchJobs}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors"
        >
          ផ្ទុកឡើងវិញ (Refresh)
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-300 text-sm">
          កំពុងផ្ទុកប្រវត្តិការងារ...
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 bg-[#111827]/40 rounded-2xl border border-slate-800 space-y-3">
          <History className="w-10 h-10 text-slate-400 mx-auto" />
          <h4 className="text-base font-semibold text-slate-300">មិនទាន់មានប្រវត្តិការងារនៅឡើយទេ</h4>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            សូមត្រឡប់ទៅផ្ទាំង "ស្ទូឌីយោ" ដើម្បីបញ្ចូលវីដេអូដំបូងរបស់អ្នក
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
                    <h4 className="text-sm font-semibold text-white truncate max-w-xs sm:max-w-md">
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

                <div className="flex items-center gap-2 shrink-0">
                  {isCompleted && (
                    <a
                      href={getDownloadUrl(job.id)}
                      download
                      className="p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                      title="ទាញយក MP4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  )}

                  <button
                    type="button"
                    onClick={() => onSelectJob(job)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition-all min-h-[40px]"
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
