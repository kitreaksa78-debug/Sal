import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Zap,
  Crown,
  Video,
  QrCode,
  Upload,
  Loader2,
  Clock3,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { CheckoutButton } from './CheckoutButton';
import { getPlan, PRO_PRICE_USD } from '../lib/usage';
import {
  getMyProRequests,
  submitProPayment,
  type ProPaymentRequest,
} from '../lib/api';

interface PricingPageProps {
  onSelectPlan?: (plan: 'free' | 'pro') => void;
}

/** The owner's own bank QR, placed in the site's static folder. */
const QR_IMAGE = '/qr-payment.png';

const STATUS_STYLES: Record<
  ProPaymentRequest['status'],
  { label: string; className: string; Icon: LucideIcon }
> = {
  pending: {
    label: 'កំពុងរង់ចាំការពិនិត្យ',
    className: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
    Icon: Clock3,
  },
  approved: {
    label: 'បានបើក Pro',
    className: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
    Icon: CheckCircle2,
  },
  rejected: {
    label: 'មិនបានអនុម័ត',
    className: 'text-rose-300 border-rose-500/30 bg-rose-500/10',
    Icon: XCircle,
  },
};

function formatDate(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('km-KH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Pay by bank QR: scan, pay, send the screenshot. The owner checks the payment
 * and presses Approve, which is what turns the account into Pro — nothing here
 * grants access on its own.
 */
const QrPayment: React.FC<{ priceUsd: string }> = ({ priceUsd }) => {
  const [qrMissing, setQrMissing] = useState(false);
  const [amount, setAmount] = useState(priceUsd);
  const [transactionRef, setTransactionRef] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [requests, setRequests] = useState<ProPaymentRequest[]>([]);
  const [proDays, setProDays] = useState(30);

  const load = useCallback(async () => {
    try {
      const data = await getMyProRequests();
      setRequests(data.requests);
      setProDays(data.proDays);
    } catch {
      /* an unreachable server leaves the list empty, the form still works */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!receipt) {
      setNotice({ tone: 'error', text: 'សូមជ្រើសរូបវិក្កយបត្រការបង់ប្រាក់ជាមុន។' });
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setNotice({ tone: 'error', text: 'សូមបញ្ចូលចំនួនបង់ប្រាក់។' });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      await submitProPayment({ amount: value, transactionRef, receipt });
      setReceipt(null);
      setTransactionRef('');
      setNotice({
        tone: 'ok',
        text: `បានផ្ញើវិក្កយបត្ររួចរាល់។ អ្នកបានបង់ប្រាក់ ដើម្បីឲ្យអ្នកពិនិត្យ ហើយ Pro នឹងបើកដោយស្វថ្ម្មក្នុងរយៈពេលប៉ុន្មាន។`,
      });
      await load();
    } catch (err: any) {
      setNotice({ tone: 'error', text: err?.message || 'មិនអាចផ្ញើវិក្កយបត្របានទេ។' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-center text-[11px] sm:text-xs leading-relaxed text-slate-300">
        បង់តាម QR របស់ CHING KEA រួចផ្ញើវិក្កយបត្រមកវិញ — រយៈពេល {proDays} ថ្ងៃក្នុងមួយដើម្បីបង់។
      </p>

      {qrMissing ? (
        /* The owner has not placed the QR image yet. Say so plainly instead of
           leaving a blank space where the customer expects something to scan. */
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 text-left">
          <QrCode className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p className="text-[11px] leading-relaxed text-amber-200 sm:text-xs">
            កូដ QR មិនទាន់បានដាក់នៅឡើយ។ សូមបង់ប្រាក់ទៅគណនី <span className="font-semibold">CHING KEA</span>{' '}
            រួចផ្ញើវិក្កយបត្រខាងក្រោម ឬទាក់ទងម្ចាស់គេហទំព័រ។
            <span className="text-amber-200/70"> (Payment QR not uploaded yet — send the receipt below or contact the owner.)</span>
          </p>
        </div>
      ) : (
        <div className="flex justify-center">
          <img
            src={QR_IMAGE}
            alt="កូដ QR បង់ប្រាក់ CHING KEA"
            loading="lazy"
            onError={() => setQrMissing(true)}
            className="h-44 w-44 rounded-xl bg-white object-contain p-2 shadow-lg shadow-black/30"
          />
        </div>
      )}

      <div className="space-y-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3.5 text-left">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] font-semibold text-slate-300">ចំនួនបង់ប្រាក់ (USD)</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full min-h-[44px] rounded-lg border border-slate-800 bg-slate-900/60 px-3 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-semibold text-slate-300">
              លេខប្រវត្តិធនាគារ (បាន។)
            </span>
            <input
              type="text"
              value={transactionRef}
              onChange={(e) => setTransactionRef(e.target.value)}
              placeholder="ឧ. 0123456789"
              className="w-full min-h-[44px] rounded-lg border border-slate-800 bg-slate-900/60 px-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] font-semibold text-slate-300">វិក្កយបត្រការបង់ប្រាក់</span>
          <span className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-dashed border-emerald-500/40 bg-slate-900/40 px-3 text-xs text-slate-300 hover:border-emerald-500/70">
            <Upload className="h-4 w-4 shrink-0 text-emerald-400" />
            {receipt ? receipt.name : 'ជ្រើសរូបភាសា PNG, JPG ឬ WebP'}
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3 text-sm font-bold text-white transition-all hover:from-emerald-400 hover:to-teal-400 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
          {busy ? 'កំពុងផ្ញើ...' : 'ផ្ញើវិក្កយបត្រ (Submit)'}
        </button>

        {notice && (
          <p
            className={`text-[11px] leading-relaxed ${
              notice.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300'
            }`}
            role="status"
          >
            {notice.text}
          </p>
        )}
      </div>

      {requests.length > 0 && (
        <div className="space-y-1.5 text-left">
          {requests.slice(0, 3).map((request) => {
            const { label, className, Icon } = STATUS_STYLES[request.status];
            return (
              <div
                key={request.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2"
              >
                <span className="text-[11px] text-slate-300">
                  ${request.amount} · {formatDate(request.submittedAt)}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${className}`}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface PlanFeature {
  /** Khmer first — the language the page speaks in. */
  label: string;
  /** The English term in brackets, the way the studio labels things. */
  english?: string;
}

/** One bullet, so both cards keep the same line, spacing and icon alignment. */
const FeatureRow: React.FC<{ feature: PlanFeature }> = ({ feature }) => (
  <li className="flex items-start gap-3">
    <Check className="w-5 h-5 shrink-0 mt-0.5 text-emerald-400" />
    <span className="text-slate-300 text-sm sm:text-base">
      <strong className="text-white font-semibold">{feature.label}</strong>
      {feature.english ? <span className="text-slate-400"> ({feature.english})</span> : null}
    </span>
  </li>
);

/** The plan name, price and bullet list, laid out identically on both cards. */
const PlanCard: React.FC<{
  Icon: LucideIcon;
  iconClass: string;
  cardClass: string;
  title: string;
  price: string;
  period: string;
  features: PlanFeature[];
  children: React.ReactNode;
}> = ({ Icon, iconClass, cardClass, title, price, period, features, children }) => (
  <div className={`relative flex flex-col h-full rounded-2xl border p-5 sm:p-7 ${cardClass}`}>
    {/* Header — the same height on both cards so the prices sit on one line. */}
    <div className="flex items-start gap-3.5 mb-5">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconClass}`}>
        <Icon className="w-5 h-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-xl sm:text-2xl font-bold text-white leading-tight">{title}</h3>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-3xl sm:text-4xl font-bold text-white leading-none">{price}</span>
          <span className="text-sm text-slate-400">{period}</span>
        </div>
      </div>
    </div>

    <ul className="flex-1 space-y-3 mb-6">
      {features.map((feature) => (
        <FeatureRow key={feature.label} feature={feature} />
      ))}
    </ul>

    {children}
  </div>
);

const FREE_FEATURES: PlanFeature[] = [
  { label: '3 វីដេអូ', english: 'per day' },
  { label: '2 នាទី', english: 'per video' },
  { label: 'បង្ហាញ 720p', english: 'output' },
  { label: 'សំឡេងខ្មែរ', english: 'Khmer voice' },
  { label: 'បកប្រែ AI', english: 'AI translation' },
];

const PRO_FEATURES: PlanFeature[] = [
  { label: 'វីដេអូឥតកំណត់', english: 'unlimited' },
  { label: '30 នាទី', english: 'per video' },
  { label: 'បង្ហាញ 1080p', english: 'output' },
  { label: 'ដំណើរការលឿនជាងគេ', english: 'priority processing' },
  { label: 'ប្រើប្រាស់ API', english: 'API access' },
  { label: 'គ្មានស្ទាត់', english: 'no watermark' },
];

/**
 * Pro unlocks automatically for the signed-in account, so this page only has to
 * offer the two plans and hand the Pro button to the checkout.
 */
export const PricingPage: React.FC<PricingPageProps> = ({ onSelectPlan }) => {
  const isPro = getPlan() === 'pro';

  return (
    <div className="max-w-5xl mx-auto py-6 sm:py-10">
      {/* Header */}
      <div className="text-center mb-8 sm:mb-12">
        <h2 className="text-2xl sm:text-4xl font-bold text-white mb-3">
          តម្លៃ <span className="text-emerald-400">សាមញ្ញ</span>
        </h2>
        <p className="text-sm sm:text-lg text-slate-400 max-w-2xl mx-auto">
          ចាប់ផ្តើមដោយឥតគិតថ្លៃ។ អភិវឌ្ឍន៍ជាមួយ Pro នៅពេលអ្នករួចរាល់។
        </p>
      </div>

      {/* Plans Grid — both cards stretch to the same height and line up. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8 max-w-4xl mx-auto">
        <PlanCard
          Icon={Video}
          iconClass="bg-slate-800 text-slate-400"
          cardClass="bg-[#0d1320] border-slate-800 hover:border-slate-700"
          title="Free"
          price="$0"
          period="/ខែ"
          features={FREE_FEATURES}
        >
          <button
            type="button"
            onClick={() => onSelectPlan?.('free')}
            className="w-full min-h-[48px] py-3 px-6 rounded-xl border border-slate-700 text-white font-semibold hover:bg-slate-800 transition-colors"
          >
            {isPro ? 'បន្តប្រើប្រាស់' : 'ចាប់ផ្តើមឥតគិតថ្លៃ'}
          </button>
        </PlanCard>

        {/* Pro — the badge hangs above the card, so the card itself keeps the
            same padding as Free and both headers stay on one line. */}
        <div className="relative">
          <span className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-xs sm:text-sm font-bold px-3.5 py-1.5 rounded-full shadow-lg whitespace-nowrap inline-flex items-center gap-1">
            <Crown className="w-3.5 h-3.5" />
            POPULAR
          </span>

          <PlanCard
            Icon={Zap}
            iconClass="bg-emerald-500/20 text-emerald-400"
            cardClass="bg-gradient-to-b from-emerald-900/20 to-[#0d1320] border-emerald-500/30 hover:border-emerald-500/50 shadow-lg shadow-emerald-500/10"
            title="Pro"
            price={`$${PRO_PRICE_USD}`}
            period="/ខែ"
            features={PRO_FEATURES}
          >
            <div className="space-y-3">
              <QrPayment priceUsd={PRO_PRICE_USD} />
              <div className="border-t border-slate-800 pt-3">
                <CheckoutButton className="w-full" />
                <p className="mt-1.5 text-center text-[10px] text-slate-500">
                  ឬបង់ផ្ទាល់តាមកាត LemonSqueezy — Pro បើកភ្លាមៗ
                </p>
              </div>
            </div>
          </PlanCard>
        </div>
      </div>
    </div>
  );
};
