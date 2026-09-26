import crypto from 'crypto';
import { getDatabase } from './db.js';
import { ProPaymentRequest, ProRequestStatus, SessionRecord, UserRecord } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Pro by bank transfer instead of a payment gateway.
 *
 * The customer scans the owner's QR, pays, and uploads the receipt; the owner
 * checks the bank and presses Approve. Nothing here decides a payment on its
 * own — the plan only changes when the owner says so, which is why the receipt
 * is kept and the decision is recorded next to it.
 */

/** How long one approved payment buys. */
export const PRO_DAYS = 30;
/** What the customer is asked to pay, in USD. */
export const PRO_PRICE_USD = 9.99;
/** A receipt is a phone photo of a payment screen; anything larger is not one. */
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

const ALLOWED_RECEIPT_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export function isAllowedReceiptType(mime: string): boolean {
  return ALLOWED_RECEIPT_TYPES.has(mime.toLowerCase());
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True while the account's Pro window is still open. */
export function isProUser(user: UserRecord | null | undefined): boolean {
  if (!user || user.plan !== 'pro') return false;
  if (!user.proExpiresAt) return true;
  return new Date(user.proExpiresAt).getTime() > Date.now();
}

/** What the pricing page shows for one account: plan, expiry and open request. */
export async function getProStatus(email: string): Promise<{
  plan: 'free' | 'pro';
  proExpiresAt: string | null;
  pendingRequest: ProPaymentRequest | null;
}> {
  const users = await getDatabase().listUsers(1000);
  const user = users.find((u) => normalizeEmail(u.email) === normalizeEmail(email)) || null;
  const requests = user ? await getDatabase().listProRequestsForUser(user.id) : [];
  return {
    plan: isProUser(user) ? 'pro' : 'free',
    proExpiresAt: user?.proExpiresAt ?? null,
    pendingRequest: requests.find((r) => r.status === 'pending') ?? null,
  };
}

export interface NewProRequestInput {
  session: SessionRecord;
  amount: number;
  transactionRef?: string;
  note?: string;
  /** Where multer put the uploaded image. */
  receiptPath: string;
  receiptMime: string;
}

/**
 * File a receipt for the owner to check. A new pending request replaces an older
 * one for the same account, so a customer who uploaded the wrong screenshot
 * does not have two half-finished claims in the admin list.
 */
export async function submitProRequest(input: NewProRequestInput): Promise<ProPaymentRequest> {
  const db = getDatabase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PRO_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const previous = (await db.listProRequestsForUser(input.session.userId)).find(
    (r) => r.status === 'pending'
  );
  if (previous) {
    await db.updateProRequest(previous.id, { status: 'rejected', reviewNote: 'បានជំនួសដោយវិក្កយបត្រថ្មី' });
  }

  const request: ProPaymentRequest = {
    id: crypto.randomBytes(8).toString('hex'),
    userId: input.session.userId,
    email: normalizeEmail(input.session.email),
    amount: input.amount,
    transactionRef: input.transactionRef,
    note: input.note,
    receiptFile: `${requestFileName(input.session.userId, now)}`,
    receiptMime: input.receiptMime,
    status: 'pending',
    submittedAt: now.toISOString(),
    proExpiresAt: expiresAt,
  };

  await db.createProRequest(request);
  logger.info(
    `Pro payment receipt filed by ${request.email} ($${request.amount}) — waiting for the owner's review`
  );
  return request;
}

/** A private, unguessable name: the receipt is never served by the file route. */
function requestFileName(userId: string, now: Date): string {
  return `receipt-${now.getTime()}-${crypto
    .createHash('sha1')
    .update(`${userId}:${now.getTime()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16)}.img`;
}

/**
 * The owner's decision. Approving opens a Pro window; approving again while Pro
 * is still running extends it rather than shortening the customer's access.
 */
export async function decideProRequest(
  id: string,
  decision: 'approve' | 'reject',
  note?: string
): Promise<ProPaymentRequest | null> {
  const db = getDatabase();
  const request = await db.getProRequest(id);
  if (!request) return null;

  const status: ProRequestStatus = decision === 'approve' ? 'approved' : 'rejected';
  const reviewedAt = new Date();

  let proExpiresAt = request.proExpiresAt ?? null;
  if (status === 'approved') {
    const user = await db.getUser(request.userId);

    // Extend from whichever is later: the moment the owner approves, or the end
    // of a Pro window the account still has. Deriving this from the request's
    // submit-time timestamp instead could hand a renewing customer a *shorter*
    // window than they already paid for when the owner reviews days later.
    const currentExpiry = user?.proExpiresAt ? new Date(user.proExpiresAt) : null;
    const base =
      currentExpiry && currentExpiry.getTime() > reviewedAt.getTime() ? currentExpiry : reviewedAt;
    proExpiresAt = new Date(base.getTime() + PRO_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // The account has to exist: the receipt may come from a signed-in session
    // whose profile is already stored, but an owner decision must still land on
    // a real record.
    if (user) {
      await db.updateUser(request.userId, {
        plan: 'pro',
        proStartedAt: user.proStartedAt ?? reviewedAt.toISOString(),
        proExpiresAt,
      });
    }
  }

  const updated = await db.updateProRequest(id, {
    status,
    reviewedAt: reviewedAt.toISOString(),
    reviewNote: note || null,
    proExpiresAt,
  });

  logger.info(
    `Pro payment ${id} ${status} by the owner (${request.email}, $${request.amount})${
      proExpiresAt ? ` — Pro until ${proExpiresAt}` : ''
    }`
  );
  return updated;
}
