import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getStorage } from './storage.js';

const LS_API = 'https://api.lemonsqueezy.com/v1';
const STATE_KEY = 'billing.json';

export type Plan = 'free' | 'pro';

export interface Entitlement {
  email: string;
  plan: Plan;
  /** LemonSqueezy subscription status: active, on_trial, paused, cancelled, expired. */
  status: string;
  subscriptionId?: string;
  customerId?: string;
  variantId?: string;
  renewsAt?: string | null;
  updatedAt: string;
}

export interface PlanVariant {
  productId: string;
  productName: string;
  variantId: string;
  isSubscription: boolean;
  interval: string | null;
  intervalCount: number | null;
}

export interface BillingConfig {
  configured: boolean;
  webhookConfigured: boolean;
  storeName?: string;
  storeUrl?: string;
  currency?: string;
  /** Test mode means payments are simulated and no real money moves. */
  testMode: boolean;
  product?: PlanVariant;
  /** Human-readable reasons the checkout is not available yet. */
  missing: string[];
}

interface BillingState {
  entitlements: Entitlement[];
}

interface LsResource {
  id: string;
  attributes: Record<string, unknown>;
}

interface LsListResponse {
  data?: LsResource[];
  meta?: { test_mode?: boolean };
}

interface LsItemResponse {
  data?: LsResource;
  meta?: { test_mode?: boolean };
}

/** Statuses that keep a paying customer on the Pro plan. */
const ACTIVE_STATUSES = new Set(['active', 'on_trial', 'paused']);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class BillingService {
  private apiKey: string;
  private state: BillingState = { entitlements: [] };
  private product: PlanVariant | null = null;
  private store: { id: string; name: string; url: string; currency: string } | null = null;
  private testMode = false;
  private resolvedAt = 0;
  private resolution: Promise<void> | null = null;

  constructor() {
    this.apiKey = (process.env.LEMONSQUEEZY_API_KEY || '').trim();
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T | null> {
    if (!this.apiKey) return null;
    try {
      const res = await fetch(`${LS_API}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(init?.headers || {}),
        },
      });
      if (!res.ok) {
        logger.warn(`LemonSqueezy ${path} responded ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      logger.warn(`LemonSqueezy ${path} request failed:`, err);
      return null;
    }
  }

  /**
   * Look up the store and the first product/variant so the checkout URL can be
   * built without anyone copy-pasting a link into the code. The LemonSqueezy API
   * is read-only for stores/products, so this resolves what the dashboard holds.
   */
  private async resolve(): Promise<void> {
    if (!this.apiKey) return;

    const storeId = (process.env.LEMONSQUEEZY_STORE_ID || '').trim();
    const stores = await this.request<LsListResponse>(storeId ? `/stores/${storeId}` : '/stores');

    let storeResource: LsResource | undefined;
    if (storeId && stores?.data && !Array.isArray(stores.data)) {
      storeResource = stores.data as unknown as LsResource;
    } else {
      const list = await this.request<LsListResponse>('/stores');
      storeResource = list?.data?.[0];
    }
    if (!storeResource) {
      logger.warn('No LemonSqueezy store found for the configured API key.');
      return;
    }

    const attrs = storeResource.attributes;
    this.store = {
      id: storeResource.id,
      name: asString(attrs.name) || 'Store',
      url: asString(attrs.url) || `https://${asString(attrs.slug)}.lemonsqueezy.com`,
      currency: asString(attrs.currency) || 'USD',
    };

    // Whether the key itself is a test-mode key decides if payments are real;
    // the catalog endpoints do not always report it, /users/me always does.
    const me = await this.request<LsItemResponse>('/users/me');
    this.testMode = Boolean(me?.meta?.test_mode);

    const products = await this.request<LsListResponse>(
      `/products?filter[store_id]=${this.store.id}`
    );

    const product = products?.data?.find((p) => asString(p.attributes.status) !== 'draft') ||
      products?.data?.[0];
    if (!product) {
      logger.info('LemonSqueezy store is ready but has no products yet.');
      return;
    }

    const variants = await this.request<LsListResponse>(
      `/variants?filter[product_id]=${product.id}`
    );
    const variant = variants?.data?.find((v) => v.attributes.is_subscription) || variants?.data?.[0];
    if (!variant) {
      logger.warn(`Product ${product.id} has no variants yet.`);
      return;
    }

    this.product = {
      productId: product.id,
      productName: asString(product.attributes.name) || 'Pro',
      variantId: variant.id,
      isSubscription: Boolean(variant.attributes.is_subscription),
      interval: asString(variant.attributes.interval) || null,
      intervalCount: asNumber(variant.attributes.interval_count),
    };
    logger.info(
      `LemonSqueezy checkout ready: ${this.product.productName} (variant ${this.product.variantId}, ${this.store.currency})`
    );
  }

  /**
   * Cached for a minute so the checkout endpoint stays cheap, and forceable so a
   * product created in the dashboard shows up without waiting for a redeploy.
   */
  async ensureResolved(force = false): Promise<void> {
    if (!this.apiKey) return;
    if (!force && this.resolvedAt && Date.now() - this.resolvedAt < 60_000) return;
    if (!this.resolution) {
      this.resolution = this.resolve()
        .catch((err) => logger.warn('Failed to resolve LemonSqueezy catalog:', err))
        .finally(() => {
          this.resolvedAt = Date.now();
          this.resolution = null;
        });
    }
    await this.resolution;
  }

  async getConfig(force = false): Promise<BillingConfig> {
    const missing: string[] = [];
    if (!this.apiKey) missing.push('LEMONSQUEEZY_API_KEY');
    await this.ensureResolved(force);
    if (this.apiKey && !this.store) missing.push('store');
    if (this.store && !this.product) missing.push('product');

    return {
      configured: Boolean(this.apiKey && this.product),
      webhookConfigured: Boolean((process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '').trim()),
      storeName: this.store?.name,
      storeUrl: this.store?.url,
      currency: this.store?.currency,
      testMode: this.testMode,
      product: this.product ?? undefined,
      missing,
    };
  }

  /** Build a hosted checkout URL, prefilling the buyer's email when we have it. */
  async getCheckoutUrl(email?: string, force = false): Promise<string | null> {
    await this.ensureResolved(force);
    if (!this.store || !this.product) return null;

    const url = new URL(`${this.store.url}/checkout/buy/${this.product.variantId}`);
    url.searchParams.set('embed', '0');
    const redirect = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
    if (redirect) url.searchParams.set('checkout[redirect_url]', `${redirect}/?upgraded=1`);
    if (email && email.includes('@')) {
      url.searchParams.set('checkout[email]', normalizeEmail(email));
    }
    return url.toString();
  }

  // ------------------------------------------------------------------ entitlements

  private persist(): void {
    void getStorage()
      .setState(STATE_KEY, JSON.stringify({ entitlements: this.state.entitlements }, null, 2))
      .catch((err) => logger.warn('Failed to persist billing entitlements:', err));
  }

  async hydrateFromRemote(): Promise<void> {
    try {
      const raw = await getStorage().getState(STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<BillingState>;
      if (Array.isArray(parsed.entitlements)) {
        this.state.entitlements = parsed.entitlements.filter(
          (e): e is Entitlement => Boolean(e && typeof e.email === 'string')
        );
        logger.info(`Recovered ${this.state.entitlements.length} billing entitlement(s)`);
      }
    } catch (err) {
      logger.warn('Failed to read billing entitlements from storage:', err);
    }
  }

  private upsert(entitlement: Entitlement): Entitlement {
    const email = normalizeEmail(entitlement.email);
    const existing = this.state.entitlements.find((e) => e.email === email);
    const record: Entitlement = { ...entitlement, email };
    if (existing) {
      Object.assign(existing, record);
    } else {
      this.state.entitlements.push(record);
    }
    this.persist();
    return record;
  }

  findByEmail(email: string): Entitlement | null {
    const target = normalizeEmail(email);
    return this.state.entitlements.find((e) => e.email === target) || null;
  }

  getPlan(email: string): Plan {
    const record = this.findByEmail(email);
    if (!record) return 'free';
    return record.plan === 'pro' && ACTIVE_STATUSES.has(record.status) ? 'pro' : 'free';
  }

  pendingCount(): number {
    return this.state.entitlements.filter((e) => this.getPlan(e.email) === 'pro').length;
  }

  /** Called from the webhook and from the "restore purchase" endpoint. */
  applySubscription(input: {
    email: string;
    status: string;
    subscriptionId?: string;
    customerId?: string;
    variantId?: string;
    renewsAt?: string | null;
  }): Entitlement {
    return this.upsert({
      email: input.email,
      plan: ACTIVE_STATUSES.has(input.status) ? 'pro' : 'free',
      status: input.status,
      subscriptionId: input.subscriptionId,
      customerId: input.customerId,
      variantId: input.variantId,
      renewsAt: input.renewsAt ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Fallback for when the webhook has not fired (or is not configured yet):
   * ask LemonSqueezy directly whether this email has a live subscription.
   */
  async syncFromSubscriptions(email: string): Promise<Entitlement | null> {
    await this.ensureResolved(true);
    if (!this.store) return null;
    const target = normalizeEmail(email);

    for (let page = 1; page <= 5; page++) {
      const list = await this.request<LsListResponse>(
        `/subscriptions?filter[store_id]=${this.store.id}&page[size]=100&page[number]=${page}`
      );
      const rows = list?.data;
      if (!rows || rows.length === 0) return null;

      const match = rows.find((s) => {
        const attrs = s.attributes;
        const candidates = [asString(attrs.user_email), asString(attrs.user_name)];
        return candidates.some((c) => c && normalizeEmail(c) === target);
      });
      if (match) {
        const attrs = match.attributes;
        const status = asString(attrs.status) || 'inactive';
        return this.applySubscription({
          email: target,
          status,
          subscriptionId: match.id,
          customerId: asString(attrs.customer_id),
          variantId: asString(attrs.variant_id),
          renewsAt: asString(attrs.renews_at) ?? null,
        });
      }
      if (rows.length < 100) return null;
    }
    return null;
  }

  /** Constant-time comparison of the X-Signature header against an HMAC of the body. */
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    const secret = (process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '').trim();
    if (!secret || !signature) return false;
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(signature.trim(), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Map a LemonSqueezy `subscriptions` webhook payload onto an entitlement. */
  applyWebhookPayload(payload: unknown): Entitlement | null {
    const data = (payload as { data?: { id?: string; attributes?: Record<string, unknown> } })?.data;
    const attrs = data?.attributes;
    if (!attrs) return null;

    const email = asString(attrs.user_email);
    const status = asString(attrs.status);
    if (!email || !status) return null;

    return this.applySubscription({
      email,
      status,
      subscriptionId: asString(data?.id),
      customerId: asString(attrs.customer_id),
      variantId: asString(attrs.variant_id),
      renewsAt: asString(attrs.renews_at) ?? null,
    });
  }

  async flushRemote(): Promise<void> {
    await getStorage()
      .setState(STATE_KEY, JSON.stringify({ entitlements: this.state.entitlements }, null, 2))
      .catch((err) => logger.warn('Failed to flush billing entitlements:', err));
  }
}

let instance: BillingService | null = null;

export function getBilling(): BillingService {
  if (!instance) instance = new BillingService();
  return instance;
}
