import express, { Request, Response } from 'express';
import {
  getGoogleAuthConfig,
  verifyGoogleAccessToken,
  verifyGoogleCredential,
} from '../services/auth.js';
import { getDatabase } from '../services/db.js';
import { isAppOwner } from '../services/accounts.js';
import { readSessionToken, requireSession } from '../middleware/session.js';
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
    const db = getDatabase();
    const user = await db.upsertUser(profile);
    // The token is what ties every later request (uploads, history, usage) to
    // this account and nobody else's.
    const session = await db.createSession(user);
    res.status(201).json({ ok: true, user, token: session.token });
  } catch (err) {
    logger.warn('Rejected a Google sign-in:', err);
    res.status(401).json({
      error: 'ការចូលដោយ Google បរាជ័យ។ សូមព្យាយាមម្តងទៀត។ (Google sign-in failed)',
    });
  }
});

/**
 * GET /api/auth/me
 * The account behind the caller's token — used to confirm a stored sign-in is
 * still valid before showing the app.
 */
router.get('/me', async (req: Request, res: Response) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const user = await getDatabase().getUser(session.userId);
  if (!user) {
    await getDatabase().deleteSession(session.token);
    return res.status(401).json({ error: 'គណនីនេះលែងមានទៀតទេ។', signInRequired: true });
  }

  res.json({ ok: true, user });
});

/**
 * POST /api/auth/signout
 * Forgets the caller's session so a shared device can be handed over safely.
 */
router.post('/signout', async (req: Request, res: Response) => {
  const token = readSessionToken(req);
  if (token) await getDatabase().deleteSession(token);
  res.json({ ok: true });
});

/**
 * GET /api/auth/users?limit=200
 * The saved accounts, newest login first.
 *
 * Only the owner of the app may read the whole list: the account that has been
 * around the longest, or anyone named in `OWNER_EMAILS`. Everyone else sees their
 * own record and a total, because one account must never see another's details.
 */
router.get('/users', async (req: Request, res: Response) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 1000) : 200;

  try {
    const db = getDatabase();
    const users = await db.listUsers(limit);

    if (!(await isAppOwner(session))) {
      const own = users.find((user) => user.id === session.userId) || null;
      return res.json({ total: users.length, scope: 'self', users: own ? [own] : [] });
    }

    res.json({ total: users.length, scope: 'all', users });
  } catch (err) {
    logger.error('Failed to list users:', err);
    res.status(500).json({ error: 'មិនអាចអានបញ្ជីអ្នកប្រើបានទេ។' });
  }
});

export default router;
