// Tests for public/js/opt-out.js, run against public/index.html in jsdom with fetch stubbed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { PUBLIC_DIR, VALID_FCCID } from './helpers.mjs';

const HTML = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const SCRIPT = readFileSync(path.join(PUBLIC_DIR, 'js', 'opt-out.js'), 'utf8');
const PHP = readFileSync(path.join(PUBLIC_DIR, 'api', 'opt-out.php'), 'utf8');
const IE_FORM_URL = 'https://www.aciuk.co.uk/form-dd-ie';
const REDIRECT_DELAY_MS = Number(SCRIPT.match(/const REDIRECT_DELAY_MS = (\d+);/)[1]);

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

/**
 * Loads the page at ?utm_id=<fccid> and runs opt-out.js.
 * `fetchImpl(url, init)` stands in for the network; every call is recorded in `calls`.
 */
async function load({ query = `?utm_id=${VALID_FCCID}`, fetchImpl, html = HTML } = {}) {
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    // jsdom doesn't implement navigation; record it instead of failing.
    if (/navigation/i.test(err.message)) navigations.push(err.message);
    else throw err;
  });
  const dom = new JSDOM(html, {
    url: `https://www.aciuk.co.uk/opt-out/${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, init) => {
    calls.push({ url, init });
    return (fetchImpl || okResponse)(url, init);
  };
  window.eval(SCRIPT);
  // Like a deferred script, init runs on DOMContentLoaded; wait for it.
  if (window.document.readyState === 'loading') {
    await new Promise((r) => window.document.addEventListener('DOMContentLoaded', r));
  }
  const $ = (id) => window.document.getElementById(id);
  return { dom, window, $, calls, navigations };
}

function okResponse() {
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
}
function errorResponse(status) {
  return () => ({ ok: false, status, json: async () => ({ ok: false }) });
}

function submit(page, reason) {
  if (reason !== undefined) {
    page.$('optout-reason').value = reason;
    page.$('optout-reason').dispatchEvent(new page.window.Event('change'));
  }
  page.$('optout-form').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
}

describe('opt-out.js: account link', () => {
  for (const [name, query] of [
    ['no utm_id', ''],
    ['an empty utm_id', '?utm_id='],
    ['a non-UUID utm_id', '?utm_id=12345'],
    ['a utm_id with an extra character', `?utm_id=${VALID_FCCID}0`],
  ]) {
    test(`shows the "no account" message for ${name}`, async () => {
      const page = await load({ query });
      assert.equal(page.$('optout-view-form').hidden, true);
      assert.equal(page.$('optout-view-nolink').hidden, false);
      assert.equal(page.$('optout-view-done').hidden, true);
    });
  }

  test('shows the form for a valid UUID', async () => {
    const page = await load();
    assert.equal(page.$('optout-view-form').hidden, false);
    assert.equal(page.$('optout-view-nolink').hidden, true);
  });

  test('accepts an upper-case UUID with surrounding whitespace', async () => {
    const page = await load({ query: `?utm_id=%20${VALID_FCCID.toUpperCase()}%20` });
    assert.equal(page.$('optout-view-form').hidden, false);
  });

  test('hides the demo-mode note', async () => {
    assert.equal((await load()).$('optout-demo-note').hidden, true);
  });
});

describe('opt-out.js: validation', () => {
  test('requires a reason before submitting', async () => {
    const page = await load();
    submit(page);
    await flush();
    assert.equal(page.calls.length, 0);
    assert.equal(page.$('optout-reason-err').hidden, false);
    assert.equal(page.$('optout-reason').getAttribute('aria-invalid'), 'true');
    assert.ok(page.$('optout-reason').classList.contains('form-error'));
    assert.equal(page.window.document.activeElement, page.$('optout-reason'));
  });

  test('clears the error once a reason is chosen', async () => {
    const page = await load();
    submit(page);
    page.$('optout-reason').value = 'uncertain';
    page.$('optout-reason').dispatchEvent(new page.window.Event('change'));
    assert.equal(page.$('optout-reason-err').hidden, true);
    assert.equal(page.$('optout-reason').getAttribute('aria-invalid'), 'false');
    assert.ok(!page.$('optout-reason').classList.contains('form-error'));
  });
});

describe('opt-out.js: submitting', () => {
  test('POSTs the FCCID and reason as JSON to the data-api URL', async () => {
    const page = await load();
    submit(page, 'cantAffordMediumTerm');
    await flush();
    assert.equal(page.calls.length, 1);
    const { url, init } = page.calls[0];
    assert.equal(url, '/api/opt-out.php');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { FCCID: VALID_FCCID, Reason: 'cantAffordMediumTerm' });
    assert.ok(init.signal, 'request has a timeout signal');
  });

  test('uses a custom data-api URL', async () => {
    const html = HTML.replace('data-api="/api/opt-out.php"', 'data-api="https://forms.example/api/opt-out.php"');
    const page = await load({ html });
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.calls[0].url, 'https://forms.example/api/opt-out.php');
  });

  test('falls back to /api/opt-out.php without data-api', async () => {
    const page = await load({ html: HTML.replace(' data-api="/api/opt-out.php"', '') });
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.calls[0].url, '/api/opt-out.php');
  });

  test('sends the trimmed FCCID', async () => {
    const page = await load({ query: `?utm_id=%20${VALID_FCCID}%20` });
    submit(page, 'uncertain');
    await flush();
    assert.equal(JSON.parse(page.calls[0].init.body).FCCID, VALID_FCCID);
  });

  test('disables the button while saving', async () => {
    let release;
    const page = await load({ fetchImpl: () => new Promise((r) => { release = () => r(okResponse()); }) });
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.$('optout-submit').disabled, true);
    assert.equal(page.$('optout-submit').textContent, 'Saving…');
    release();
    await flush();
    assert.equal(page.$('optout-view-done').hidden, false);
  });

  test('shows the confirmation and a link to the I&E form on success', async () => {
    const page = await load();
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.$('optout-view-form').hidden, true);
    assert.equal(page.$('optout-view-done').hidden, false);
    assert.equal(page.$('optout-redirect-msg').hidden, false);
    assert.equal(page.window.document.activeElement, page.$('optout-done-title'));

    const link = new URL(page.$('optout-redirect-link').href);
    assert.equal(`${link.origin}${link.pathname}`, IE_FORM_URL);
    assert.equal(link.searchParams.get('FCCID'), VALID_FCCID);
    // The reason is stored by the API, not passed on in the URL.
    assert.deepEqual([...link.searchParams.keys()], ['FCCID']);
  });

  test('treats a successful response without a JSON body as success', async () => {
    const page = await load({ fetchImpl: () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError(); } }) });
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.$('optout-view-done').hidden, false);
  });

  test('redirects to the I&E form after a short delay', async () => {
    const page = await load();
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.navigations.length, 0, 'does not redirect immediately');
    await new Promise((r) => setTimeout(r, REDIRECT_DELAY_MS + 200));
    assert.equal(page.navigations.length, 1, 'redirected after the delay');
    page.window.close();
  });
});

describe('opt-out.js: errors', () => {
  for (const [name, fetchImpl] of [
    ['a server error', errorResponse(500)],
    ['a bad gateway', errorResponse(502)],
    ['a network failure', () => { throw new TypeError('Failed to fetch'); }],
  ]) {
    test(`shows a generic error and re-enables the button on ${name}`, async () => {
      const page = await load({ fetchImpl });
      submit(page, 'uncertain');
      await flush();
      assert.equal(page.$('optout-view-form').hidden, false);
      assert.equal(page.$('optout-view-done').hidden, true);
      assert.equal(page.$('optout-submit-err').hidden, false);
      assert.match(page.$('optout-submit-err').textContent, /couldn't save your choice/);
      assert.equal(page.$('optout-submit').disabled, false);
      assert.equal(page.$('optout-submit').textContent, 'Opt out');
    });
  }

  test('shows a "too many attempts" message on 429', async () => {
    const page = await load({ fetchImpl: errorResponse(429) });
    submit(page, 'uncertain');
    await flush();
    assert.match(page.$('optout-submit-err').textContent, /Too many attempts/);
  });

  test('shows a "busy" message on 503', async () => {
    const page = await load({ fetchImpl: errorResponse(503) });
    submit(page, 'uncertain');
    await flush();
    assert.match(page.$('optout-submit-err').textContent, /busy/);
    assert.equal(page.$('optout-submit').disabled, false);
  });

  test('clears a previous error when retrying', async () => {
    let fail = true;
    const page = await load({ fetchImpl: () => (fail ? errorResponse(500)() : okResponse()) });
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.$('optout-submit-err').hidden, false);
    fail = false;
    submit(page);
    assert.equal(page.$('optout-submit-err').hidden, true);
    await flush();
    assert.equal(page.$('optout-view-done').hidden, false);
  });
});

describe('front end and proxy stay in sync', () => {
  test('the form offers exactly the reasons the proxy accepts', () => {
    const { window } = new JSDOM(HTML);
    const options = [...window.document.querySelectorAll('#optout-reason option')]
      .map((o) => o.value)
      .filter(Boolean);
    const allowed = [...PHP.match(/const ALLOWED_REASONS = \[(.*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(options.sort(), allowed.sort());
  });

  test('the FCCID patterns match', () => {
    const js = SCRIPT.match(/const FCCID_PATTERN = \/(.*)\/i;/)[1];
    const php = PHP.match(/const FCCID_PATTERN = '\/(.*)\/i';/)[1];
    assert.equal(js, php);
  });
});
