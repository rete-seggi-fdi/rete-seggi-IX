const DEFAULT_APP_ORIGIN = 'https://rete-seggi-fdi.github.io';

function allowedOrigin(request, env) {
  const configured = String(env.APP_ORIGIN || DEFAULT_APP_ORIGIN).trim().replace(/\/$/, '');
  const origin = String(request.headers.get('Origin') || '').trim().replace(/\/$/, '');
  if (!origin) return '';
  return origin === configured ? origin : null;
}

function responseHeaders(origin) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-headers': 'content-type, authorization, idempotency-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  return headers;
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders(origin)
  });
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (origin === null) {
      return json({ ok: false, code: 'ORIGIN_NOT_ALLOWED', error: 'Origine non autorizzata.' }, 403, '');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM municipalities').first();
      return json({ ok: true, backend: 'cloudflare-d1', version: '14.0.7', municipalities: row?.n || 0 }, 200, origin);
    }

    return json({
      ok: false,
      code: 'NOT_IMPLEMENTED',
      error: 'Worker D1 predisposto ma non ancora abilitato per dati elettorali reali.'
    }, 501, origin);
  }
};
