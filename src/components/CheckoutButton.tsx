import React from 'react';
import { Zap, ExternalLink } from 'lucide-react';

interface CheckoutButtonProps {
  variant?: 'primary' | 'secondary';
  className?: string;
}

// LemonSqueezy checkout URL - replace with your actual checkout URL
const LEMONSQUEEZY_CHECKOUT_URL = 'https://YOUR_STORE.lemonsqueezy.com/checkout/buy/YOUR_PRODUCT_ID';

export const CheckoutButton: React.FC<CheckoutButtonProps> = ({ 
  variant = 'primary',
  className = '' 
}) => {
  const handleCheckout = () => {
    // Open LemonSqueezy checkout in new tab
    window.open(LEMONSQUEEZY_CHECKOUT_URL, '_blank');
  };

  if (variant === 'secondary') {
    return (
      <button
        onClick={handleCheckout}
        className={`inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-emerald-500/30 text-emerald-400 font-semibold hover:bg-emerald-500/10 transition-all ${className}`}
      >
        <Zap className="w-4 h-4" />
        Upgrade to Pro
        <ExternalLink className="w-3 h-3 opacity-50" />
      </button>
    );
  }

  return (
    <button
      onClick={handleCheckout}
      className={`inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold text-lg hover:from-emerald-600 hover:to-teal-600 transition-all shadow-lg shadow-emerald-500/25 ${className}`}
    >
      <Zap className="w-5 h-5" />
      Upgrade to Pro — $9.99/ខែ
      <ExternalLink className="w-4 h-4 opacity-75" />
    </button>
  );
};
