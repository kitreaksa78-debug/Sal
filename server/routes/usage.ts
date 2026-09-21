import express, { Request, Response } from 'express';
import { getDatabase } from '../services/db.js';
import { requireSession } from '../middleware/session.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/usage
 * How much of today's free allowance this account has used.
 *
 * The server owns the number (it is bumped whenever an upload starts), so every
 * account has its own count and no browser can reset it.
 */
router.get('/', async (req: Request, res: Response) => {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    const usage = await getDatabase().getDailyUsage(session.userId);
    res.json({ ...usage, account: { id: session.userId, email: session.email } });
  } catch (err) {
    logger.error('Failed to read usage:', err);
    res.status(500).json({ error: 'មិនអាចអានការប្រើប្រាស់បានទេ។' });
  }
});

export default router;
