import dotenv from 'dotenv';

/**
 * Load environment variables as the very first thing the server does.
 *
 * This intentionally lives in its own module that `server.ts` imports before
 * anything else, because several modules read `process.env` while they are being
 * evaluated (FFmpeg binary paths, upload limits, storage config). Runtime
 * auto-loading only covers `.env`, so `.env.local` — where the freebuff keys UI
 * writes secrets — is loaded explicitly here. Explicit paths come first so they
 * take precedence, and dotenv never overrides already-set variables.
 */
dotenv.config({ path: ['.env.local', '.env'] });
