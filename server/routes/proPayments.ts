import express, { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDatabase } from '../services/db.js';
import { getStorage } from '../services/storage.js';
import { requireSession } from '../middleware/session.js';
import { isAppOwner } from '../services/accounts.js';
import { SessionRecord } from '../types.js';
import {
  MAX_RECEIPT_BYTES,
  PRO_DAYS,
  PRO_PRICE_USD,
  decideProRequest,
  isAllowedReceiptType,
  submitProRequest,
} from '../services/proPayments.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// The receipt lands in a temp folder first; the pipeline stores it properly
// afterwards (and R2 keeps it alive across restarts on a free host).
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(os.tmpdir(), 'pro-receipts');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.img';
      cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!isAllowedReceiptType(file.mimetype)) {
      cb(new Error('សូមផ្ទាល់រូបភាសា PNG, JPG ឬ WebP តែប៉ុណ្ណោះ។ (Only PNG, JPG or WebP receipts.)'));
      return;
    }
    cb(null, true);
  },
});

/** The owner is the only one who reviews payments, the same as the stem panel. */
async function requireAdmin(req: Request, res: Response): Promise<SessionRecord | null> {
  const session = await requireSession(req, res);
  if (!session) return null;
  if (!(await isAppOwner(session))) {
    res.status(403).json({ error: 'តែគណនី Admin ទេ។ (Admin only.)' });
    return null;
  }
  return session;
}

/**
 * POST /api/pro/requests  (multipart: receipt, amount, transactionRef, note)
 * The customer paid by bank QR and sends the screenshot of it.
 */
router.post('/requests', upload.single('receipt'), async (req: Request, res: Response) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const file = req.file;
  let tempPath: string | null = null;
  try {
    if (!file) {
      return res.status(400).json({
        error: 'សូមផ្ទាល់រូបវិក្កយបត្រការបង់ប្រាក់។ (A photo of the payment is required.)',
      });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'សូមបញ្ចូលចំនួនបង់ប្រាក់។ (Enter the amount you paid.)' });
    }

    const request = await submitProRequest({
      session,
      amount,
      transactionRef: typeof req.body?.transactionRef === 'string' ? req.body.transactionRef.trim() : '',
      note: typeof req.body?.note === 'string' ? req.body.note.trim() : '',
      receiptPath: file.path,
      receiptMime: file.mimetype,
    });

    // Move the upload into the private receipts category, under the recorded name.
    const storage = getStorage();
    const stored = await storage.saveFile('receipts', request.receiptFile, file.path);
    tempPath = stored;

    return res.json({ request });
  } catch (err: any) {
    logger.error('Failed to file a Pro payment receipt:', err);
    if (tempPath && fs.existsSync(tempPath)) {
      await getStorage().deleteFile('receipts', path.basename(tempPath)).catch(() => {});
    }
    if (file && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        /* the temp folder is disposable anyway */
      }
    }
    return res.status(500).json({
      error: err?.message || 'មិនអាចផ្ញើវិក្កយបត្របានទេ។',
    });
  } finally {
    if (file && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        /* already moved */
      }
    }
  }
});

/**
 * GET /api/pro/requests/mine
 * What happened to this account's payments, newest first.
 */
router.get('/requests/mine', async (req: Request, res: Response) => {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    const requests = await getDatabase().listProRequestsForUser(session.userId);
    res.json({ requests, proDays: PRO_DAYS, priceUsd: PRO_PRICE_USD });
  } catch (err) {
    logger.error('Failed to read the Pro payment requests:', err);
    res.status(500).json({ error: 'មិនអាចអានការបង់ប្រាក់បានទេ។' });
  }
});

/** GET /api/pro/requests — every receipt, for the owner to check. */
router.get('/requests', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  try {
    const requests = await getDatabase().listProRequests(200);
    res.json({ requests, proDays: PRO_DAYS, priceUsd: PRO_PRICE_USD });
  } catch (err) {
    logger.error('Failed to list the Pro payment receipts:', err);
    res.status(500).json({ error: 'មិនអាចអានការបង់ប្រាក់បានទេ។' });
  }
});

/**
 * GET /api/pro/requests/:id/receipt
 * The screenshot itself: the owner, or the customer who uploaded it.
 */
router.get('/requests/:id/receipt', async (req: Request, res: Response) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const request = await getDatabase().getProRequest(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'រកមិនឃើញវិក្កយបត្រនេះ។' });
  }

  const allowed = request.userId === session.userId || (await isAppOwner(session));
  if (!allowed) {
    return res.status(403).json({ error: 'តែអ្នកបានផ្ញើ ឬ Admin ទេដែលអាចមើលបាន។' });
  }

  try {
    const filePath = await getStorage().ensureFileAvailable('receipts', request.receiptFile);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'រូបវិក្កយបត្រត្រូវការផ្ទាល់ម្តងទៀត។' });
    }
    res.type(request.receiptMime || 'image/png');
    res.sendFile(filePath);
  } catch (err) {
    logger.error('Failed to serve a payment receipt:', err);
    res.status(500).json({ error: 'មិនអាចបង្ហាញវិក្កយបត្របានទេ។' });
  }
});

/**
 * POST /api/pro/requests/:id/decision  { decision: 'approve' | 'reject', note? }
 * The owner accepts the payment (the account becomes Pro) or turns it down.
 */
router.post('/requests/:id/decision', async (req: Request, res: Response) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'សូមជ្រើស approve ឬ reject។' });
  }

  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  const request = await decideProRequest(req.params.id, decision, note);
  if (!request) {
    return res.status(404).json({ error: 'រកមិនឃើញការបង់ប្រាក់នេះ។' });
  }
  res.json({ request });
});

export default router;
