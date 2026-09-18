import React from 'react';
import { X, CheckCircle2, XCircle, ShieldCheck, Cpu, HardDrive, Sparkles, Mic, Volume2 } from 'lucide-react';
import { SystemConfigStatus } from '../types';

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: SystemConfigStatus | null;
  loading: boolean;
}

export const ConfigModal: React.FC<ConfigModalProps> = ({ isOpen, onClose, config, loading }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#111827] border border-slate-800 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">ស្ថានភាពប្រព័ន្ធ និង API (System Status)</h3>
              <p className="text-[11px] text-slate-400">ត្រួតពិនិត្យភាពរួចរាល់នៃម៉ូឌុល AI និង Server</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-4">
          {loading ? (
            <div className="py-8 text-center text-slate-400 text-sm">
              កំពុងពិនិត្យសេវាកម្ម...
            </div>
          ) : !config ? (
            <div className="py-8 text-center text-rose-400 text-sm">
              មិនអាចទាញយកព័ត៌មានប្រព័ន្ធបានទេ។
            </div>
          ) : (
            <div className="space-y-3">
              {/* Notice that keys are secure */}
              <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 text-[11px] text-slate-400 leading-relaxed">
                🔒 <strong className="text-slate-200">Security Architecture:</strong> API keys are safely held in server environment variables and never exposed to the client browser.
              </div>

              <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
                {/* AI Translation */}
                <div className="p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    <div>
                      <div className="text-xs font-semibold text-white">AI Translation → Khmer</div>
                      <div className="text-[10px] text-slate-400">
                        Provider: {config.translation.provider} ({config.translation.model})
                      </div>
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                      config.translation.configured
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {config.translation.configured ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Connected</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Not configured</span>
                      </>
                    )}
                  </span>
                </div>

                {/* STT */}
                <div className="p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Mic className="w-4 h-4 text-teal-400" />
                    <div>
                      <div className="text-xs font-semibold text-white">Speech-to-Text (STT)</div>
                      <div className="text-[10px] text-slate-400">Provider: {config.stt.provider} ({config.stt.model})</div>
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                      config.stt.configured
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {config.stt.configured ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Configured</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Not configured</span>
                      </>
                    )}
                  </span>
                </div>

                {/* TTS */}
                <div className="p-3.5 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Volume2 className="w-4 h-4 text-cyan-400" />
                      <div>
                        <div className="text-xs font-semibold text-white">Khmer Text-to-Speech (TTS)</div>
                        <div className="text-[10px] text-slate-400">Provider: {config.tts.provider} ({config.tts.model})</div>
                      </div>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                        config.tts.configured
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {config.tts.configured ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Configured</span>
                        </>
                      ) : (
                        <>
                          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                          <span>Subtitles only</span>
                        </>
                      )}
                    </span>
                  </div>

                  {!config.tts.configured && (
                    <div className="text-[10.5px] text-amber-400/90 leading-relaxed">
                      💡 បញ្ចូល key សម្រាប់ TTS ខ្មែរ (ឧ.{' '}
                      <code className="text-slate-200 font-mono bg-slate-800 px-1 py-0.5 rounded">GEMINI_API_KEY</code>) ដើម្បីបង្កើតសំឡេងខ្មែរ។ បើគ្មាន វេទិកានឹងបង្កើតវីដេអូជាមួយអក្សររត់ខ្មែរ និងរក្សាសំឡេងដើម។
                    </div>
                  )}
                </div>

                {/* Audio Separation */}
                <div className="p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Cpu className="w-4 h-4 text-indigo-400" />
                    <div>
                      <div className="text-xs font-semibold text-white">Voice & Music Audio Separation</div>
                      <div className="text-[10px] text-slate-400">Engine: {config.audioSeparation.provider} (DSP Filter)</div>
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                      config.audioSeparation.configured
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Configured</span>
                  </span>
                </div>

                {/* Storage */}
                <div className="p-3.5 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <HardDrive className="w-4 h-4 text-emerald-400" />
                      <div>
                        <div className="text-xs font-semibold text-white">
                          {config.storage.provider}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {config.storage.bucket ? (
                            <>Bucket: <span className="text-slate-200 font-mono">{config.storage.bucket}</span> • Max video: {config.maxVideoSizeMb} MB</>
                          ) : (
                            <>Max video: {config.maxVideoSizeMb} MB</>
                          )}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                        config.storage.configured
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {config.storage.configured ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Connected</span>
                        </>
                      ) : (
                        <>
                          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                          <span>Waiting for S3 Keys</span>
                        </>
                      )}
                    </span>
                  </div>

                  {config.storage.endpoint && (
                    <div className="text-[10px] text-slate-400 bg-slate-900/90 rounded-lg p-2 font-mono flex flex-col gap-1 border border-slate-800/60">
                      <div className="truncate">
                        <span className="text-slate-400">Endpoint:</span> {config.storage.endpoint}
                      </div>
                      {config.storage.bucket && (
                        <div>
                          <span className="text-slate-400">Target Bucket:</span> <span className="text-emerald-400 font-bold">{config.storage.bucket}</span>
                        </div>
                      )}
                      {!config.storage.configured && (
                        <div className="text-amber-400/90 mt-0.5 not-italic font-sans text-[10.5px]">
                          💡 Set <code className="text-slate-200 font-mono bg-slate-800 px-1 py-0.5 rounded">S3_ACCESS_KEY_ID</code> and <code className="text-slate-200 font-mono bg-slate-800 px-1 py-0.5 rounded">S3_SECRET_ACCESS_KEY</code> in Settings / Secrets to activate S3 synchronization.
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* FFmpeg */}
                <div className="p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Cpu className="w-4 h-4 text-amber-400" />
                    <div>
                      <div className="text-xs font-semibold text-white">FFmpeg Media Engine</div>
                      <div className="text-[10px] text-slate-400">{config.ffmpeg.version || 'FFmpeg ready'}</div>
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                      config.ffmpeg.configured
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {config.ffmpeg.configured ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Ready</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Not found</span>
                      </>
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/30 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-colors"
          >
            បិទ (Close)
          </button>
        </div>
      </div>
    </div>
  );
};
