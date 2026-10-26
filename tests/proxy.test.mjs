// Black-box tests for public/api/opt-out.php, run under `php -S` against a local HTTPS stand-in for the OptOut API.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startProxy, startUpstream, freePort, testCert, VALID_FCCID } from './helpers.mjs';

const API_KEY = 'test-key-123';

function assertSecurityHeaders(res) {
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
}

describe('opt-out proxy', () => {
  let upstream;
  let proxy;

  before(async () => {
    upstream = await startUpstream();
    proxy = await startProxy({
      config: {
        api_url: upstream.url,
        api_key: API_KEY,
        allowed_origins: ['https://www.aciuk.co.uk'],
        rate_limit_max: 1000,
      },
    });
  });
  after(async () => {
    await proxy?.stop();
    await upstream?.close();
  });
  beforeEach(() => {
    upstream.requests.length = 0;
    upstream.respond = (req, body, res) => { res.writeHead(200); res.end('{"result":"ok"}'); };
  });

  describe('successful opt-out', () => {
    test('forwards FCCID and Reason with the API key and returns ok', async () => {
      const res = await proxy.request();
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true });
      assertSecurityHeaders(res);

      assert.equal(upstream.requests.length, 1);
      const up = upstream.requests[0];
      assert.equal(up.method, 'POST');
      assert.equal(up.url, '/api/OptOut');
      assert.equal(up.headers['x-functions-key'], API_KEY);
      assert.equal(up.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(up.body), { FCCID: VALID_FCCID, Reason: 'cantAffordShortTerm' });
    });

    for (const reason of ['cantAffordShortTerm', 'cantAffordMediumTerm', 'uncertain']) {
      test(`accepts reason "${reason}"`, async () => {
        const res = await proxy.request({ body: { FCCID: VALID_FCCID, Reason: reason } });
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(upstream.requests[0].body).Reason, reason);
      });
    }

    test('accepts upper-case FCCIDs and trims surrounding whitespace', async () => {
      const res = await proxy.request({ body: { FCCID: `  ${VALID_FCCID.toUpperCase()} `, Reason: 'uncertain' } });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(upstream.requests[0].body).FCCID, VALID_FCCID.toUpperCase());
    });

    test('drops extra fields instead of forwarding them', async () => {
      const res = await proxy.request({
        body: { FCCID: VALID_FCCID, Reason: 'uncertain', Admin: true, 'x-functions-key': 'evil' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(JSON.parse(upstream.requests[0].body)), ['FCCID', 'Reason']);
    });

    test('accepts a JSON content type with a charset', async () => {
      const res = await proxy.request({ contentType: 'application/json; charset=utf-8' });
      assert.equal(res.status, 200);
    });

    test('never returns the API key or the upstream body to the browser', async () => {
      upstream.respond = (req, body, res) => { res.writeHead(200); res.end(`{"secret":"${API_KEY}","name":"Jane"}`); };
      const res = await proxy.request();
      assert.equal(res.status, 200);
      assert.ok(!res.text.includes(API_KEY));
      assert.ok(!res.text.includes('Jane'));
    });
  });

  describe('origin and CORS', () => {
    test('rejects requests without an Origin header', async () => {
      const res = await proxy.request({ origin: null });
      assert.equal(res.status, 403);
      assert.deepEqual(res.json, { ok: false, error: 'origin_not_allowed' });
      assert.equal(upstream.requests.length, 0);
    });

    test('rejects requests from an unlisted origin', async () => {
      const res = await proxy.request({ origin: 'https://evil.example' });
      assert.equal(res.status, 403);
      assert.equal(res.json.error, 'origin_not_allowed');
      assert.equal(upstream.requests.length, 0);
    });

    test('rejects an origin that only differs by scheme', async () => {
      const res = await proxy.request({ origin: `https://localhost:${proxy.port}` });
      assert.equal(res.status, 403);
    });

    test('same-origin requests get no CORS headers', async () => {
      const res = await proxy.request();
      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });

    test('an allowed cross origin gets CORS headers', async () => {
      const res = await proxy.request({ origin: 'https://www.aciuk.co.uk' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], 'https://www.aciuk.co.uk');
      assert.equal(res.headers['access-control-allow-methods'], 'POST');
      assert.equal(res.headers['access-control-allow-headers'], 'Content-Type');
      assert.equal(res.headers.vary, 'Origin');
    });

    test('answers a CORS preflight with 204 and no body', async () => {
      const res = await proxy.request({ method: 'OPTIONS', origin: 'https://www.aciuk.co.uk', body: undefined });
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      assert.equal(res.headers['access-control-allow-origin'], 'https://www.aciuk.co.uk');
      assert.equal(upstream.requests.length, 0);
    });
  });

  describe('request validation', () => {
    test('rejects GET with 405 and an Allow header', async () => {
      const res = await proxy.request({ method: 'GET', body: undefined });
      assert.equal(res.status, 405);
      assert.equal(res.json.error, 'method_not_allowed');
      assert.equal(res.headers.allow, 'POST');
    });

    test('rejects non-JSON content types', async () => {
      const res = await proxy.request({ contentType: 'application/x-www-form-urlencoded', body: 'FCCID=x&Reason=y' });
      assert.equal(res.status, 415);
      assert.equal(res.json.error, 'json_required');
    });

    test('rejects bodies over 2 KB', async () => {
      const res = await proxy.request({ body: { FCCID: VALID_FCCID, Reason: 'uncertain', pad: 'x'.repeat(2100) } });
      assert.equal(res.status, 413);
      assert.equal(res.json.error, 'payload_too_large');
    });

    test('accepts a body of exactly 2 KB', async () => {
      const base = JSON.stringify({ FCCID: VALID_FCCID, Reason: 'uncertain', pad: '' });
      const body = JSON.stringify({ FCCID: VALID_FCCID, Reason: 'uncertain', pad: 'x'.repeat(2048 - base.length) });
      assert.equal(body.length, 2048);
      const res = await proxy.request({ body });
      assert.equal(res.status, 200);
    });

    for (const [name, body] of [['malformed JSON', '{"FCCID":'], ['a JSON string', '"hello"'], ['an empty body', ' ']]) {
      test(`rejects ${name}`, async () => {
        const res = await proxy.request({ body });
        assert.equal(res.status, 400);
        assert.equal(res.json.error, 'invalid_json');
      });
    }

    for (const [name, fccid] of [
      ['missing', undefined],
      ['empty', ''],
      ['a number', 12345],
      ['not a UUID', 'ABC123'],
      ['a UUID without dashes', VALID_FCCID.replace(/-/g, '')],
      ['a UUID with non-hex characters', 'zzzzzzzz-7a4d-4e9b-9c2a-1d5e6f7a8b9c'],
      ['a UUID with trailing content', `${VALID_FCCID}x`],
      ['a UUID followed by a newline and more', `${VALID_FCCID}\nabc`],
    ]) {
      test(`rejects an FCCID that is ${name}`, async () => {
        const res = await proxy.request({ body: { FCCID: fccid, Reason: 'uncertain' } });
        assert.equal(res.status, 400);
        assert.equal(res.json.error, 'invalid_fccid');
        assert.equal(upstream.requests.length, 0);
      });
    }

    for (const [name, reason] of [
      ['missing', undefined],
      ['unknown', 'other'],
      ['the wrong case', 'Uncertain'],
      ['an array', ['uncertain']],
    ]) {
      test(`rejects a reason that is ${name}`, async () => {
        const res = await proxy.request({ body: { FCCID: VALID_FCCID, Reason: reason } });
        assert.equal(res.status, 400);
        assert.equal(res.json.error, 'invalid_reason');
        assert.equal(upstream.requests.length, 0);
      });
    }
  });

  describe('upstream failures', () => {
    test('maps an upstream error status to a generic 502', async () => {
      upstream.respond = (req, body, res) => { res.writeHead(500); res.end('{"error":"customer Jane Smith not found"}'); };
      const res = await proxy.request();
      assert.equal(res.status, 502);
      assert.deepEqual(res.json, { ok: false, error: 'upstream_error' });
      assert.ok(!res.text.includes('Jane'));
    });

    test('logs the upstream status but not its body', async () => {
      upstream.respond = (req, body, res) => { res.writeHead(404); res.end('customer Jane Smith'); };
      await proxy.request();
      const log = proxy.errorLog();
      assert.match(log, /upstream returned HTTP 404/);
      assert.ok(!log.includes('Jane'));
      assert.ok(!log.includes(API_KEY));
    });

    for (const status of [429, 503]) {
      test(`maps an upstream ${status} to 503 upstream_busy with a default Retry-After`, async () => {
        upstream.respond = (req, body, res) => { res.writeHead(status); res.end('busy'); };
        const res = await proxy.request();
        assert.equal(res.status, 503);
        assert.deepEqual(res.json, { ok: false, error: 'upstream_busy' });
        assert.equal(res.headers['retry-after'], '60');
        assertSecurityHeaders(res);
        assert.match(proxy.errorLog(), new RegExp(`upstream busy, HTTP ${status}`));
      });
    }

    test('passes on the upstream Retry-After when it is in seconds', async () => {
      upstream.respond = (req, body, res) => { res.writeHead(503, { 'Retry-After': '20' }); res.end(); };
      const res = await proxy.request();
      assert.equal(res.status, 503);
      assert.equal(res.headers['retry-after'], '20');
    });

    test('caps a long upstream Retry-After at 5 minutes', async () => {
      upstream.respond = (req, body, res) => { res.writeHead(429, { 'Retry-After': '86400' }); res.end(); };
      const res = await proxy.request();
      assert.equal(res.headers['retry-after'], '300');
    });

    test('uses the default for a Retry-After that is not in seconds', async () => {
      upstream.respond = (req, body, res) => {
        res.writeHead(503, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' });
        res.end();
      };
      const res = await proxy.request();
      assert.equal(res.headers['retry-after'], '60');
    });

    test('an allowed cross origin gets CORS headers on upstream_busy', async () => {
      upstream.respond = (req, body, res) => { res.writeHead(503); res.end(); };
      const res = await proxy.request({ origin: 'https://www.aciuk.co.uk' });
      assert.equal(res.status, 503);
      assert.equal(res.headers['access-control-allow-origin'], 'https://www.aciuk.co.uk');
    });

    test('does not follow upstream redirects', async () => {
      upstream.respond = (req, body, res) => { res.writeHead(302, { Location: 'https://127.0.0.1:1/' }); res.end(); };
      const res = await proxy.request();
      assert.equal(res.status, 502);
      assert.equal(res.json.error, 'upstream_error');
      assert.equal(upstream.requests.length, 1);
    });
  });
});

describe('opt-out proxy configuration', () => {
  test('returns 500 when no API key is configured', async () => {
    const proxy = await startProxy({ config: { api_url: 'https://127.0.0.1:1/', api_key: '' } });
    try {
      const res = await proxy.request();
      assert.equal(res.status, 500);
      assert.equal(res.json.error, 'not_configured');
    } finally { await proxy.stop(); }
  });

  test('refuses a non-HTTPS API URL', async () => {
    const proxy = await startProxy({ config: { api_url: 'http://127.0.0.1:1/', api_key: API_KEY } });
    try {
      const res = await proxy.request();
      assert.equal(res.status, 500);
      assert.equal(res.json.error, 'not_configured');
    } finally { await proxy.stop(); }
  });

  test('returns 502 when the API is unreachable', async () => {
    const port = await freePort();
    const proxy = await startProxy({ config: { api_url: `https://127.0.0.1:${port}/`, api_key: API_KEY } });
    try {
      const res = await proxy.request();
      assert.equal(res.status, 502);
      assert.equal(res.json.error, 'upstream_unreachable');
    } finally { await proxy.stop(); }
  });

  test('refuses an API whose TLS certificate is not trusted', async () => {
    const upstream = await startUpstream();
    // curl trusts a different certificate from the one the upstream presents.
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY },
      caFile: testCert('other').certFile,
    });
    try {
      const res = await proxy.request();
      assert.equal(res.status, 502);
      assert.equal(res.json.error, 'upstream_unreachable');
      assert.equal(upstream.requests.length, 0);
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });

  test('environment variables take precedence over the config file', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({
      config: { api_url: 'https://127.0.0.1:1/', api_key: 'file-key' },
      env: { OPTOUT_API_URL: upstream.url, OPTOUT_API_KEY: 'env-key' },
    });
    try {
      const res = await proxy.request();
      assert.equal(res.status, 200);
      assert.equal(upstream.requests[0].headers['x-functions-key'], 'env-key');
    } finally {
      await proxy.stop();
      await upstream.close();
    }
  });
});

describe('opt-out proxy transport and rate limiting', () => {
  let upstream;
  before(async () => { upstream = await startUpstream(); });
  after(async () => { await upstream?.close(); });

  test('refuses plain HTTP from a non-local host', async () => {
    const proxy = await startProxy({ config: { api_url: upstream.url, api_key: API_KEY } });
    try {
      const res = await proxy.request({ host: 'www.aciuk.co.uk', origin: 'http://www.aciuk.co.uk' });
      assert.equal(res.status, 403);
      assert.equal(res.json.error, 'https_required');
    } finally { await proxy.stop(); }
  });

  test('ignores X-Forwarded-Proto from an untrusted client', async () => {
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY, trusted_proxies: ['10.0.0.0/8'] },
    });
    try {
      const res = await proxy.request({
        host: 'www.aciuk.co.uk',
        origin: 'https://www.aciuk.co.uk',
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.error, 'https_required');
    } finally { await proxy.stop(); }
  });

  test('believes X-Forwarded-Proto from a trusted proxy (CIDR match)', async () => {
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY, trusted_proxies: ['127.0.0.0/8'] },
    });
    try {
      const res = await proxy.request({
        host: 'www.aciuk.co.uk',
        origin: 'https://www.aciuk.co.uk',
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.equal(res.status, 200);
    } finally { await proxy.stop(); }
  });

  test('rate limits after the configured number of attempts', async () => {
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY, rate_limit_max: 3, rate_limit_window_s: 600 },
    });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await proxy.request()).status, 200);
      const res = await proxy.request();
      assert.equal(res.status, 429);
      assert.equal(res.json.error, 'rate_limited');
      assert.equal(res.headers['retry-after'], '600');
    } finally { await proxy.stop(); }
  });

  test('allows 30 attempts per IP by default', async () => {
    const proxy = await startProxy({ config: { api_url: upstream.url, api_key: API_KEY } });
    try {
      for (let i = 0; i < 30; i++) assert.equal((await proxy.request()).status, 200);
      assert.equal((await proxy.request()).status, 429);
    } finally { await proxy.stop(); }
  });

  test('invalid requests also count towards the rate limit', async () => {
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY, rate_limit_max: 2 },
    });
    try {
      for (let i = 0; i < 2; i++) {
        assert.equal((await proxy.request({ body: { FCCID: 'guess', Reason: 'uncertain' } })).status, 400);
      }
      assert.equal((await proxy.request()).status, 429);
    } finally { await proxy.stop(); }
  });

  test('uses the forwarded client IP from a trusted proxy', async () => {
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY, rate_limit_max: 1, trusted_proxies: ['127.0.0.1'] },
    });
    try {
      const as = (ip) => proxy.request({ headers: { 'X-Forwarded-For': ip } });
      assert.equal((await as('203.0.113.1')).status, 200);
      assert.equal((await as('203.0.113.1')).status, 429);
      assert.equal((await as('203.0.113.2')).status, 200);
      // Only the last entry (added by our proxy) counts; a spoofed first entry doesn't help.
      assert.equal((await as('198.51.100.9, 203.0.113.1')).status, 429);
    } finally { await proxy.stop(); }
  });

  test('ignores X-Forwarded-For from an untrusted client', async () => {
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY, rate_limit_max: 1 },
    });
    try {
      assert.equal((await proxy.request({ headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 200);
      assert.equal((await proxy.request({ headers: { 'X-Forwarded-For': '203.0.113.2' } })).status, 429);
    } finally { await proxy.stop(); }
  });

  test('groups IPv6 clients by /64', async () => {
    const proxy = await startProxy({
      config: { api_url: upstream.url, api_key: API_KEY, rate_limit_max: 1, trusted_proxies: ['127.0.0.1'] },
    });
    try {
      const as = (ip) => proxy.request({ headers: { 'X-Forwarded-For': ip } });
      assert.equal((await as('2001:db8:0:0::1')).status, 200);
      assert.equal((await as('2001:db8:0:0::ffff')).status, 429);
      assert.equal((await as('2001:db8:0:1::1')).status, 200);
    } finally { await proxy.stop(); }
  });
});
