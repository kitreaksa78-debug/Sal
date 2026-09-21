import express, { Request, Response } from 'express';
import {
  getGoogleAuthConfig,
  verifyGoogleAccessToken,
  verifyGoogleCredential,
} from '../services/auth.js';
import { getDatabase } from '../services/db.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/auth/config
 * Whether Google sign-in is ready, plus the public client id the browser needs.
 */
router.get('/config', (req: Request, res: Response) => {
  const config = getGoogleAuthConfig();
  res.json({ google: { configured: config.configured, clientId: config.clientId } });
});

/**
 * POST /api/auth/google  { accessToken } | { credential }
 * The token handed back by Google Identity Services: an OAuth 2.0 access token
 * from the button, or an ID token from One Tap. Either way it is verified with
 * Google and the account is stored, so the user list survives a restart.
 */
router.post('/google', async (req: Request, res: Response) => {
  const read = (key: string) => (typeof req.body?.[key] === 'string' ? req.body[key].trim() : '');
  const accessToken = read('accessToken');
  const credential = read('credential');

  if (!accessToken && !credential) {
    return res.status(400).json({ error: 'សូមផ្តល់លេខសម្គាល់ Google។ (Missing Google credential)' });
  }
  if (!getGoogleAuthConfig().configured) {
    return res.status(503).json({
      error: 'Google sign-in មិនទាន់បានភ្ជាប់ទេ។ (GOOGLE_CLIENT_ID is not set on the server)',
    });
  }

  try {
    const profile = credential
      ? await verifyGoogleCredential(credential)
      : await verifyGoogleAccessToken(accessToken);
    const user = await getDatabase().upsertUser(profile);
    res.status(201).json({ ok: true, user });
  } catch (err) {
    logger.warn('Rejected a Google sign-in:', err);
    res.status(401).json({
      error: 'ការចូលដោយ Google បរាជ័យ។ សូមព្យាយាមម្តងទៀត។ (Google sign-in failed)',
    });
  }
});

/**
 * GET /api/auth/users?limit=200
 * The saved accounts, newest login first — open it in a browser to read the list.
 */
router.get('/users', async (req: Request, res: Response) => {
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 1000) : 200;

  try {
    const users = await getDatabase().listUsers(limit);
    res.json({ total: users.length, users });
  } catch (err) {
    logger.error('Failed to list users:', err);
    res.status(500).json({ error: 'មិនអាចអានបញ្ជីអ្នកប្រើបានទេ។' });
  }
});

export default router;
