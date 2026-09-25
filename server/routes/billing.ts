import express, { Request, Response } from 'express';
import { getBilling, normalizeEmail } from '../services/billing.js';
import { getProStatus } from '../services/proPayments.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/billing/plans
 * Everything the pricing UI needs: whether checkout is live, and the buy URL.
 */
router.get('/plans', async (req: Request, res: Response) => {
  const billing = getBilling();
  // ?refresh=1 re-reads the catalog so a brand new product appears immediately.
  const force = req.query.refresh === '1';
  const config = await billing.getConfig(force);
  const checkoutUrl = config.configured ? await billing.getCheckoutUrl(undefined, force) : null;
  res.json({ ...config, checkoutUrl });
});

/**
 * GET /api/billing/entitlement?email=
 * The client asks for the current plan of the email stored on this device.
 */
router.get('/entitlement', async (req: Request, res: Response) => {
  const email = typeof req.query.email === 'string' ? req.query.email : '';
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'សូមផ្តល់ email ត្រឹមត្រូវ។ (A valid email is required)' });
  }
  const billing = getBilling();
  const record = billing.findByEmail(email);
  // A Pro plan the owner granted after a bank transfer counts just as much as a
  // subscription the payment provider knows about.
  const manual = await getProStatus(email);
  res.json({
    email: normalizeEmail(email),
    plan: manual.plan === 'pro' || billing.getPlan(email) === 'pro' ? 'pro' : 'free',
    status: record?.status ?? (manual.plan === 'pro' ? 'manual' : 'none'),
    renewsAt: record?.renewsAt ?? manual.proExpiresAt ?? null,
    proExpiresAt: manual.proExpiresAt,
    pendingRequest: manual.pendingRequest,
  });
});

/**
 * POST /api/billing/activate  { email }
 * "Restore my purchase" — used right after checkout and whenever the webhook has
 * not reached this instance yet. Asks LemonSqueezy directly about the email.
 */
router.post('/activate', async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'សូមផ្តល់ email ត្រឹមត្រូវ។ (A valid email is required)' });
  }

  const billing = getBilling();
  if (!billing.isConfigured()) {
    return res.status(503).json({
      error: 'ប្រព័ន្ធបង់ប្រាក់មិនទាន់បានភ្ជាប់ទេ។ (Billing is not configured)',
    });
  }

  try {
    const record = await billing.syncFromSubscriptions(email);
    if (!record) {
      return res.status(404).json({
        email: normalizeEmail(email),
        plan: 'free',
        error: 'រកមិនឃើញការជាវសម្រាប់ email នេះទេ។ សូមពិនិត្យ email ដែលអ្នកបានបង់ប្រាក់។',
      });
    }
    res.json({
      email: record.email,
      // Never downgrade a Pro the owner granted by hand while restoring a
      // subscription that the payment provider has not caught up with yet.
      plan: (await getProStatus(record.email)).plan === 'pro' ? 'pro' : billing.getPlan(record.email),
      status: record.status,
      renewsAt: record.renewsAt ?? null,
    });
  } catch (err) {
    logger.error('Failed to activate a purchase:', err);
    res.status(500).json({ error: 'មិនអាចផ្ទៀងផ្ទាត់ការជាវបានទេ។ សូមព្យាយាមម្តងទៀត។' });
  }
});

/**
 * POST /api/billing/webhook
 * Mounted with express.raw() before the JSON parser so the HMAC can be verified.
 */
export async function handleLemonSqueezyWebhook(req: Request, res: Response) {
  const billing = getBilling();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (!billing.verifyWebhookSignature(raw, req.header('x-signature') ?? undefined)) {
    logger.warn('Rejected a LemonSqueezy webhook with an invalid signature.');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const payload = JSON.parse(raw.toString('utf8'));
    const record = billing.applyWebhookPayload(payload);
    if (!record) {
      return res.json({ received: true, applied: false, reason: 'unrecognised payload' });
    }
    logger.info(`Billing updated for ${record.email}: ${record.plan} (${record.status})`);
    res.json({ received: true, applied: true, plan: record.plan });
  } catch (err) {
    logger.error('Failed to process a LemonSqueezy webhook:', err);
    res.status(400).json({ error: 'Invalid payload' });
  }
}

export default router;
