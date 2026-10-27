// Cloudflare Pages Function: server-side proxy to TypeSafe Jev (DEC-07).
// Same behavior as api/jev.js (the Vercel version, kept until cutover).
// The API key lives only in the JEV_API_KEY secret on the Pages project and
// never reaches the browser. Only the deal-matching question shapes are forwarded.
const ALLOWED = /^(status|match|adds_w\d{1,3})$/;
const MAX_BYTES = 60_000;

const json = (body, status) => Response.json(body, { status });

export async function onRequestPost({ request, env }) {
  const key = env.JEV_API_KEY;
  if (!key) return json({ error: 'JEV_API_KEY is not set on the server' }, 503);

  let body;
  try {
    body = JSON.parse((await request.text()) || '{}');
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const { state, questions } = body || {};
  if (!state || !questions || typeof questions !== 'object') return json({ error: 'state and questions are required' }, 400);
  if (!Object.keys(questions).every(id => ALLOWED.test(id))) return json({ error: 'unexpected question' }, 400);
  const payload = JSON.stringify({ model: 'jev-latest', state, questions });
  if (payload.length > MAX_BYTES) return json({ error: 'request too large' }, 413);

  const upstream = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: payload,
  });
  const result = await upstream.json().catch(() => ({ error: 'bad upstream response' }));
  return json(result, upstream.status);
}

export function onRequest() {
  return json({ error: 'POST only' }, 405);
}
