import express, { Request, Response } from 'express';
import { getDatabase } from '../services/db.js';
import { ContactPlan } from '../types.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/** Trim and cap user input so one request cannot bloat the state snapshot. */
function clean(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/**
 * POST /api/contact  { name, email, message?, plan?, deviceId? }
 * Called by the welcome screen's "Contact with Google" button before it opens
 * Gmail, so every user who writes to us is stored on the server as well. The
 * record is part of the database snapshot, which is mirrored to R2, so it
 * survives a restart of a free host.
 */
router.post('/', async (req: Request, res: Response) => {
  const name = clean(req.body?.name, 80);
  const email = clean(req.body?.email, 160).toLowerCase();
  const message = clean(req.body?.message, 2000);
  const deviceId = clean(req.body?.deviceId, 80);
  const source = clean(req.body?.source, 40) || 'welcome';
  const plan: ContactPlan = req.body?.plan === 'pro' ? 'pro' : 'free';

  if (!name) {
    return res.status(400).json({ error: 'សូមបញ្ចូលឈ្មោះរបស់អ្នក។ (Your name is required)' });
  }
  if (!isEmail(email)) {
    return res
      .status(400)
      .json({ error: 'សូមបញ្ចូលអ៊ីមែលត្រឹមត្រូវ។ (A valid email is required)' });
  }

  try {
    const database = getDatabase();
    const contact = await database.saveContact({ name, email, message, plan, source, deviceId });
    const total = (await database.listContacts()).length;
    res.status(201).json({ ok: true, saved: true, contact, total });
  } catch (err) {
    logger.error('Failed to save a user contact:', err);
    res.status(500).json({ error: 'មិនអាចរក្សាទុកទិន្នន័យបានទេ។ សូមព្យាយាមម្តងទៀត។' });
  }
});

/**
 * GET /api/contact?limit=200
 * The saved users, newest first — open this from a browser to read the list.
 */
router.get('/', async (req: Request, res: Response) => {
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 1000) : 200;

  try {
    const contacts = await getDatabase().listContacts(limit);
    res.json({ total: contacts.length, contacts });
  } catch (err) {
    logger.error('Failed to list user contacts:', err);
    res.status(500).json({ error: 'មិនអាចអានបញ្ជីអ្នកប្រើបានទេ។' });
  }
});

export default router;
