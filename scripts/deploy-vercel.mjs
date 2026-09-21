/**
 * Publish an already-built static directory to Vercel (production).
 *
 * Vercel builds nothing here: the client is built first (see `deploy:vercel` in
 * package.json) and the files are uploaded as-is, so the output of a deploy is
 * exactly what `bun run build:pages` produced.
 *
 * Usage:
 *   VERCEL_TOKEN=vcp_xxx bun run deploy:vercel
 *   VERCEL_TOKEN=vcp_xxx node scripts/deploy-vercel.mjs <dir> [project]
 *
 * Optional:
 *   API_BACKEND_URL  host the /api/* rewrite proxies to (default: the Render server)
 *   VERCEL_TEAM      team id, when the project lives in a team account
 *
 * The custom domain (aivideotranslate.dev) stays attached to the project, so a new
 * production deployment is live on it as soon as this script reports READY.
 */
import fs from 'fs';
import path from 'path';

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM = process.env.VERCEL_TEAM;
const DIR = process.argv[2] || 'dist-pages';
const PROJECT = process.argv[3] || 'khmerdub-ai';
const BACKEND = (process.env.API_BACKEND_URL || 'https://sal-juma.onrender.com').replace(/\/+$/, '');

if (!TOKEN) {
  console.error('✗ VERCEL_TOKEN is missing. Create one at https://vercel.com/account/tokens');
  process.exit(1);
}

if (!fs.existsSync(DIR)) {
  console.error(`✗ ${DIR} does not exist — run "bun run build:pages" first.`);
  process.exit(1);
}

/** Same two rules the Cloudflare Pages project uses: proxied API and SPA fallback. */
const REWRITES = [
  { source: '/api/:path*', destination: `${BACKEND}/api/:path*` },
  { source: '/(.*)', destination: '/index.html' },
];

/**
 * Every file is uploaded inline as base64. The `encoding` field is what tells
 * Vercel to decode it — without it the base64 text itself is stored as the file
 * body, and the browser then shows a page of base64 characters.
 */
function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else out.push({ file: rel, data: fs.readFileSync(full).toString('base64'), encoding: 'base64' });
  }
  return out;
}

const files = walk(DIR);
console.log(`→ uploading ${files.length} file(s) from ${DIR} as project "${PROJECT}"`);

const url =
  'https://api.vercel.com/v13/deployments?forceNew=1&skipAutoDetectionConfirmation=1' +
  (TEAM ? `&teamId=${TEAM}` : '');

const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: PROJECT,
    project: PROJECT,
    target: 'production',
    files,
    rewrites: REWRITES,
  }),
});

const data = await res.json();
if (!res.ok) {
  console.error(`✗ deployment failed (${res.status}):`, JSON.stringify(data).slice(0, 800));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      id: data.id,
      projectId: data.projectId,
      deployment: `https://${data.url}`,
      status: data.status ?? data.readyState,
    },
    null,
    2
  )
);
console.log('✓ The custom domain serves this deployment once the status is READY.');
