import React, { useState } from 'react';
import { ArrowRight, Crown, Mail, Sparkles, Zap } from 'lucide-react';
import { getUsageStats, getPlan } from '../lib/usage';
import {
  ContactProfile,
  gmailComposeUrl,
  getContactProfile,
  getDeviceId,
  isValidEmail,
  saveContactProfile,
} from '../lib/contact';
import { saveContact } from '../lib/api';

/** Google "G" mark, inlined so the button needs no extra request. */
const GoogleG: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path
      fill="#FFC107"
      d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
    />
    <path
      fill="#FF3D00"
      d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
    />
  </svg>
);

interface WelcomePageProps {
  /**
   * Leaves the welcome screen for the dubbing studio. The app navigation (tab
   * bar) only shows once the visitor is inside the app.
   */
  onEnterApp?: () => void;
}

type Status = { kind: 'saved' | 'error' | 'warning'; text: string };

const FIELD_CLASS =
  'w-full px-3.5 py-3 rounded-xl bg-[#0b1220] border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 focus:border-emerald-500/60 transition-colors min-h-[48px]';

export const WelcomePage: React.FC<WelcomePageProps> = ({ onEnterApp }) => {
  // Step 1: only "Get started". Step 2 (after the click): contact with Google.
  const [showContact, setShowContact] = useState(false);
  const [profile, setProfile] = useState<ContactProfile>(getContactProfile());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const stats = getUsageStats();

  const handleStart = () => setShowContact(true);

  const update = (patch: Partial<ContactProfile>) =>
    setProfile((current) => ({ ...current, ...patch }));

  /**
   * Opens the Gmail draft and stores the visitor. The tab is opened first, while
   * the click is still a user gesture, so the popup blocker cannot cancel it; the
   * save then runs in the background and reports back in the panel.
   */
  const handleContact = async () => {
    const trimmed: ContactProfile = {
      name: profile.name.trim(),
      email: profile.email.trim(),
      message: profile.message.trim(),
    };

    if (!trimmed.name) {
      setStatus({ kind: 'error', text: 'សូមបញ្ចូលឈ្មោះរបស់អ្នក។' });
      return;
    }
    if (!isValidEmail(trimmed.email)) {
      setStatus({ kind: 'error', text: 'សូមបញ្ចូលអ៊ីមែលត្រឹមត្រូវ (ឧ. name@gmail.com)។' });
      return;
    }

    setStatus(null);
    setBusy(true);
    setProfile(trimmed);
    // Remember the details on this device so the next visit is pre-filled.
    saveContactProfile(trimmed);

    window.open(gmailComposeUrl(trimmed, getPlan()), '_blank', 'noopener,noreferrer');

    try {
      await saveContact({
        name: trimmed.name,
        email: trimmed.email,
        message: trimmed.message,
        plan: getPlan(),
        source: 'welcome',
        deviceId: getDeviceId(),
      });
      setStatus({
        kind: 'saved',
        text: 'បានរក្សាទុកទិន្នន័យរបស់អ្នករួចរាល់ ✓ សូមចុចផ្ញើនៅក្នុងផ្ទាំង Gmail ថ្មី។',
      });
    } catch {
      setStatus({
        kind: 'warning',
        text: 'មិនអាចរក្សាទុកលើម៉ាស៊ីនបម្រើបានទេ ប៉ុន្តែអ្នកនៅតែអាចផ្ញើអ៊ីមែលនៅក្នុងផ្ទាំងថ្មី។',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-in fade-in duration-300">
      <section className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-emerald-950/40 via-[#0b1220] to-[#0b0f17] px-5 py-14 sm:px-10 sm:py-20">
        <div className="pointer-events-none absolute -top-24 -right-20 h-60 w-60 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -left-20 h-60 w-60 rounded-full bg-teal-500/10 blur-3xl" />

        <div className="relative mx-auto max-w-2xl text-center">
          <div className="inline-flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[11px] sm:text-xs font-semibold text-emerald-300">
            <Sparkles className="w-3.5 h-3.5" />
            <span>វេទិកាបកប្រែវីដេអូ និងបញ្ចូលសំឡេងខ្មែរ AI</span>
          </div>

          <h2 className="mt-5 text-2xl sm:text-5xl font-bold text-white tracking-tight leading-snug">
            សូមស្វាគមន៍មកកាន់ <span className="text-emerald-400">KhmerDub AI</span>
          </h2>

          <p className="mt-3 text-sm sm:text-lg text-slate-300 leading-relaxed">
            បំលែងវីដេអូភាសាបរទេស ទៅជាវីដេអូភាសាខ្មែរ ដោយរក្សាភ្លេង និងសំឡេងបរិយាកាសដើម។
          </p>

          {/* Step 1 — the only call to action on arrival */}
          {!showContact && (
            <div className="mt-8">
              <button
                type="button"
                onClick={handleStart}
                className="inline-flex items-center justify-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white font-bold text-base sm:text-lg shadow-lg shadow-emerald-500/25 active:scale-95 transition-all min-h-[56px] w-full sm:w-auto"
              >
                <Zap className="w-5 h-5 shrink-0" />
                <span>Get started</span>
                <ArrowRight className="w-5 h-5 shrink-0" />
              </button>

              <p className="mt-4 text-[11px] sm:text-xs text-slate-400">
                {stats.unlimited ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-300 font-semibold">
                    <Crown className="w-3.5 h-3.5" /> Pro plan សកម្ម — វីដេអូឥតកំណត់
                  </span>
                ) : (
                  <>ឥតគិតថ្លៃ {stats.limit} វីដេអូ/ថ្ងៃ · មិនត្រូវការកាត</>
                )}
              </p>
            </div>
          )}

          {/* Step 2 — revealed after "Get started" */}
          {showContact && (
            <div className="mt-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="rounded-2xl border border-slate-800 bg-[#111827]/80 p-5 sm:p-6 text-left">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 flex items-center justify-center shrink-0">
                    <Mail className="w-5 h-5" />
                  </div>
                  <h3 className="text-base sm:text-lg font-bold text-white">Contact with Google</h3>
                </div>

                <p className="mt-3 text-xs sm:text-sm text-slate-400 leading-relaxed">
                  បំពេញព័ត៌មានខាងក្រោម រួចចុច <span className="text-slate-200 font-semibold">Contact with Google</span> —
                  ទិន្នន័យរបស់អ្នកនឹងត្រូវបានរក្សាទុក ហើយ Gmail នឹងបើកឡើងជាមួយសារដែលសរសេររួច។
                </p>

                <div className="mt-4 space-y-3">
                  <div>
                    <label
                      htmlFor="contact-name"
                      className="block mb-1.5 text-[11px] sm:text-xs font-semibold text-slate-300"
                    >
                      ឈ្មោះរបស់អ្នក (Your name)
                    </label>
                    <input
                      id="contact-name"
                      type="text"
                      autoComplete="name"
                      value={profile.name}
                      onChange={(e) => update({ name: e.target.value })}
                      placeholder="ឧ. សុខ ដារា"
                      className={FIELD_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="contact-email"
                      className="block mb-1.5 text-[11px] sm:text-xs font-semibold text-slate-300"
                    >
                      អ៊ីមែល (Email)
                    </label>
                    <input
                      id="contact-email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      value={profile.email}
                      onChange={(e) => update({ email: e.target.value })}
                      placeholder="you@gmail.com"
                      className={FIELD_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="contact-message"
                      className="block mb-1.5 text-[11px] sm:text-xs font-semibold text-slate-300"
                    >
                      សាររបស់អ្នក (Message)
                    </label>
                    <textarea
                      id="contact-message"
                      rows={3}
                      value={profile.message}
                      onChange={(e) => update({ message: e.target.value })}
                      placeholder="ខ្ញុំចង់សួរអំពី…"
                      className={`${FIELD_CLASS} resize-y`}
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleContact}
                  disabled={busy}
                  className="mt-5 w-full inline-flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-xl bg-white text-slate-800 font-semibold border border-slate-200 hover:bg-slate-100 active:scale-95 transition-all min-h-[52px] disabled:opacity-70 disabled:cursor-wait"
                >
                  <GoogleG className="w-5 h-5 shrink-0" />
                  <span>{busy ? 'កំពុងរក្សាទុក…' : 'Contact with Google'}</span>
                </button>

                {status && (
                  <p
                    className={`mt-3 text-[11px] sm:text-xs leading-relaxed ${
                      status.kind === 'saved'
                        ? 'text-emerald-300'
                        : status.kind === 'warning'
                          ? 'text-amber-300'
                          : 'text-rose-300'
                    }`}
                    role="status"
                  >
                    {status.text}
                  </p>
                )}
              </div>

              {/* The only way off this screen — the tab bar stays hidden until here */}
              {onEnterApp && (
                <button
                  type="button"
                  onClick={onEnterApp}
                  className="mt-4 mx-auto flex items-center gap-1.5 text-xs sm:text-sm font-medium text-emerald-300 hover:text-emerald-200 transition-colors underline-offset-4 hover:underline"
                >
                  <span>ចូលទៅស្ទូឌីយោ</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
