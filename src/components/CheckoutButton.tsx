import React, { useEffect, useState } from 'react';
import { Zap, ExternalLink, Loader2, AlertCircle } from 'lucide-react';
import { getBillingConfig, type BillingConfig } from '../lib/api';
import { getAccountEmail, PRO_PRICE_USD } from '../lib/usage';

interface CheckoutButtonProps {
  variant?: 'primary' | 'secondary';
  className?: string;
}

function withEmail(url: string, email: string | null): string {
  if (!email) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('checkout[email]', email);
    return parsed.toString();
  } catch {
    return url;
  }
}

export const CheckoutButton: React.FC<CheckoutButtonProps> = ({
  variant = 'primary',
  className = '',
}) => {
  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    getBillingConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const openCheckout = async () => {
    setLoading(true);
    setUnavailable(false);
    try {
      let url = config?.checkoutUrl ?? null;
      if (!url) {
        // The product may have been created after this page loaded.
        const fresh = await getBillingConfig(true);
        setConfig(fresh);
        url = fresh.checkoutUrl;
      }
      if (!url) {
        setUnavailable(true);
        return;
      }
      window.open(withEmail(url, getAccountEmail()), '_blank', 'noopener,noreferrer');
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  };

  const note = unavailable ? (
    <p className="text-[11px] text-amber-400/90 mt-2 flex items-start gap-1.5">
      <AlertCircle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
      <span>
        ប្រព័ន្ធបង់ប្រាក់កំពុងរៀបចំ។ សូមទំនាក់ទំនងយើង ឬព្យាយាមម្តងទៀតនៅពេលក្រោយ។
      </span>
    </p>
  ) : null;

  if (variant === 'secondary') {
    return (
      <div className={className}>
        <button
          type="button"
          onClick={openCheckout}
          disabled={loading}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-emerald-500/30 text-emerald-400 font-semibold hover:bg-emerald-500/10 transition-all disabled:opacity-60 disabled:cursor-wait"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          Upgrade to Pro
          <ExternalLink className="w-3 h-3 opacity-50" />
        </button>
        {note}
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={openCheckout}
        disabled={loading}
        className="w-full inline-flex items-center justify-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold text-lg hover:from-emerald-600 hover:to-teal-600 transition-all shadow-lg shadow-emerald-500/25 disabled:opacity-60 disabled:cursor-wait"
      >
        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />}
        Upgrade to Pro — ${PRO_PRICE_USD}/ខែ
        <ExternalLink className="w-4 h-4 opacity-75" />
      </button>
      {note}
    </div>
  );
};
