/**
 * Cloudflare Pages Function: proxies every /api/* request to the dubbing server.
 *
 * Cloudflare Pages only serves static files, while the KhmerDub pipeline needs a
 * Node process (FFmpeg, disk buffer, long-running jobs). Deploy that server on any
 * Node host, then set API_BACKEND_URL on this Pages project
 * (Settings -> Environment variables, e.g. https://khmerdub-api.onrender.com)
 * and the pages.dev site will talk to it transparently.
 *
 * When API_BACKEND_URL is missing we answer with a clear JSON error instead of a
 * static 404, so the UI can explain what is wrong.
 */
export async function onRequest(context) {
  const { request, env } = context;

  const backend = String(env.API_BACKEND_URL || '')
    .trim()
    .replace(/\/+$/, '');

  if (!backend) {
    return new Response(
      JSON.stringify({
        error:
          'ម៉ាស៊ីនបម្រើដំណើរការមិនទាន់បានភ្ជាប់ទេ (API_BACKEND_URL is not configured for this Pages project).',
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }
    );
  }

  const url = new URL(request.url);
  const target = backend + url.pathname + url.search;

  // Forward the request headers minus the ones that describe this host.
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });

    // Stream straight through so SSE progress updates keep working.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `មិនអាចភ្ជាប់ទៅម៉ាស៊ីនបម្រើបានទេ (cannot reach API backend): ${
          err && err.message ? err.message : 'unknown error'
        }`,
      }),
      {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }
    );
  }
}
