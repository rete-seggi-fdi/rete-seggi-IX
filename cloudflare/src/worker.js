const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, idempotency-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store'
  }
});

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: json({}).headers });
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM municipalities').first();
      return json({ ok: true, backend: 'cloudflare-d1', version: '12.0.0', municipalities: row?.n || 0 });
    }
    return json({
      ok: false,
      code: 'NOT_IMPLEMENTED',
      error: 'Worker D1 predisposto ma non ancora abilitato per dati elettorali reali.'
    }, 501);
  }
};
