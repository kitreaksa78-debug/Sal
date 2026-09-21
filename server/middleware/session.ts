import { Request, Response } from 'express';
import { getDatabase } from '../services/db.js';
import { SessionRecord } from '../types.js';

/**
 * The signed-in account behind a request.
 *
 * The browser sends the token it received at sign-in as `Authorization: Bearer`
 * (fetch/XHR) or as `?token=` — `<video>` tags and EventSource cannot set headers,
 * and the token is what keeps one account's videos and usage separate from
 * another's.
 */
export function readSessionToken(req: Request): string {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }

  const query = req.query?.token;
  return typeof query === 'string' ? query.trim() : '';
}

export async function getRequestSession(req: Request): Promise<SessionRecord | null> {
  const token = readSessionToken(req);
  if (!token) return null;

  try {
    return await getDatabase().getSession(token);
  } catch {
    return null;
  }
}

/** The message every protected route answers with when nobody is signed in. */
export const SIGN_IN_REQUIRED = 'សូមចូលដោយគណនី Google ជាមុនសិន។ (Sign in with Google first)';

/**
 * Resolves the caller or ends the request with 401. Returns `null` in that case,
 * so callers can simply `return` when it does.
 */
export async function requireSession(req: Request, res: Response): Promise<SessionRecord | null> {
  const session = await getRequestSession(req);
  if (!session) {
    res.status(401).json({ error: SIGN_IN_REQUIRED, signInRequired: true });
    return null;
  }
  return session;
}
