/**
 * POST /api/opt-out
 *
 * Server-side proxy to the Droog Media OptOut Azure Function. The browser sends
 * { FCCID, Reason } here; this adds the x-functions-key (an app setting, never
 * sent to the browser) and forwards the request.
 *
 * App settings:
 *   OPTOUT_API_URL  OptOut Function URL
 *   OPTOUT_API_KEY  x-functions-key
 */
const { app } = require('@azure/functions');

// Must match the <option> values in public/index.html.
const ALLOWED_REASONS = new Set(['cantAffordShortTerm', 'cantAffordLongTerm', 'keepCurrentArrangement']);
const FCCID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const UPSTREAM_TIMEOUT_MS = 10000;

function json(status, body) {
  return {
    status: status,
    jsonBody: body,
    headers: { 'Cache-Control': 'no-store' },
  };
}

async function optOut(request, context) {
  const apiUrl = process.env.OPTOUT_API_URL;
  const apiKey = process.env.OPTOUT_API_KEY;
  if (!apiUrl || !apiKey) {
    context.error('opt-out: OPTOUT_API_URL or OPTOUT_API_KEY is not configured');
    return json(500, { ok: false, error: 'not_configured' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  const fccid = typeof body?.FCCID === 'string' ? body.FCCID.trim() : '';
  const reason = typeof body?.Reason === 'string' ? body.Reason : '';
  if (!FCCID_PATTERN.test(fccid)) return json(400, { ok: false, error: 'invalid_fccid' });
  if (!ALLOWED_REASONS.has(reason)) return json(400, { ok: false, error: 'invalid_reason' });

  let upstream;
  try {
    upstream = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-functions-key': apiKey },
      body: JSON.stringify({ FCCID: fccid, Reason: reason }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    context.error('opt-out: upstream request failed', err);
    return json(502, { ok: false, error: 'upstream_unreachable' });
  }

  if (!upstream.ok) {
    // Log the detail server-side only; the browser just gets a generic failure.
    context.error('opt-out: upstream returned', upstream.status, await upstream.text().catch(() => ''));
    return json(502, { ok: false, error: 'upstream_error' });
  }

  return json(200, { ok: true });
}

app.http('optOut', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'opt-out',
  handler: optOut,
});

module.exports = { optOut };
