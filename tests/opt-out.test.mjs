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
const MAX_BUSY_RETRIES = Number(SCRIPT.match(/const MAX_BUSY_RETRIES = (\d+);/)[1]);
// The busy countdown shortened to 1 second, so tests don't wait 20 seconds per retry.
const FAST_RETRY_SCRIPT = SCRIPT.replace(/const BUSY_RETRY_S = \d+;/, 'const BUSY_RETRY_S = 1;');
const STORAGE_KEY = `aci-optout-done:${VALID_FCCID}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

/**
 * Loads the page at ?utm_id=<fccid> and runs opt-out.js.
 * `fetchImpl(url, init)` stands in for the network; every call is recorded in `calls`.
 */
async function load({ query = `?utm_id=${VALID_FCCID}`, fetchImpl, html = HTML, script = SCRIPT, stored = {}, before } = {}) {
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
  for (const [k, v] of Object.entries(stored)) window.sessionStorage.setItem(k, v);
  if (before) before(window);
  window.eval(script);
  // Like a deferred script, init runs on DOMContentLoaded; wait for it.
  if (window.document.readyState === 'loading') {
    await new Promise((r) => window.document.addEventListener('DOMContentLoaded', r));
  }
  const $ = (id) => window.document.getElementById(id);
  return { dom, window, $, calls, navigations };
}

function today(window) {
  const d = new window.Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    // The reason is stored by the API, not passed on in the URL.
    assert.deepEqual(Object.fromEntries(link.searchParams), {
      FCCID: VALID_FCCID,
      utm_id: VALID_FCCID,
      utm_source: 'upliftForm',
      utm_term: today(page.window),
    });
  });

  test('sends utm_term as the local submission date in YYYY-MM-DD', async () => {
    const page = await load({
      before: (window) => {
        const RealDate = window.Date;
        // 9 March 2026, 23:30 local time: single-digit month and day, late in the day.
        window.Date = class extends RealDate {
          constructor(...args) { super(...(args.length ? args : [2026, 2, 9, 23, 30])); }
        };
      },
    });
    submit(page, 'uncertain');
    await flush();
    assert.equal(new URL(page.$('optout-redirect-link').href).searchParams.get('utm_term'), '2026-03-09');
  });

  test('works where AbortSignal.timeout() is missing (Safari/iOS before 16)', async () => {
    const page = await load({ before: (window) => { delete window.AbortSignal.timeout; } });
    assert.equal(page.window.AbortSignal.timeout, undefined);
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.calls.length, 1);
    assert.ok(page.calls[0].init.signal instanceof page.window.AbortSignal, 'request still has a timeout signal');
    assert.equal(page.$('optout-view-done').hidden, false);
  });

  test('remembers the opt-out for this tab', async () => {
    const page = await load();
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.window.sessionStorage.getItem(STORAGE_KEY), today(page.window));
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
      assert.equal(page.$('optout-submit').textContent, 'Submit');
    });
  }

  test('shows a "too many attempts" message on 429', async () => {
    const page = await load({ fetchImpl: errorResponse(429) });
    submit(page, 'uncertain');
    await flush();
    assert.match(page.$('optout-submit-err').textContent, /Too many attempts/);
  });

  test('does not remember a failed opt-out', async () => {
    const page = await load({ fetchImpl: errorResponse(500) });
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.window.sessionStorage.getItem(STORAGE_KEY), null);
  });
});

describe('opt-out.js: API busy (503)', () => {
  test('counts down from 20 seconds with a cancel button, without retrying straight away', async () => {
    const page = await load({ fetchImpl: errorResponse(503) });
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.$('optout-busy').hidden, false);
    assert.equal(page.$('optout-busy-count').textContent, '20');
    assert.equal(page.$('optout-submit').disabled, true);
    assert.equal(page.$('optout-submit-err').hidden, true);
    assert.equal(page.window.document.activeElement, page.$('optout-busy-cancel'));
    await sleep(1100);
    assert.equal(page.$('optout-busy-count').textContent, '19');
    assert.equal(page.calls.length, 1);
    page.$('optout-busy-cancel').click();
  });

  test('tries again when the countdown ends', async () => {
    let busy = true;
    const page = await load({ script: FAST_RETRY_SCRIPT, fetchImpl: () => (busy ? errorResponse(503)() : okResponse()) });
    submit(page, 'cantAffordShortTerm');
    await flush();
    busy = false;
    await sleep(1200);
    await flush();
    assert.equal(page.calls.length, 2);
    assert.deepEqual(JSON.parse(page.calls[1].init.body), { FCCID: VALID_FCCID, Reason: 'cantAffordShortTerm' });
    assert.equal(page.$('optout-busy').hidden, true);
    assert.equal(page.$('optout-view-done').hidden, false);
    page.window.close();
  });

  test('cancel stops the retry and lets the customer try again themselves', async () => {
    const page = await load({ script: FAST_RETRY_SCRIPT, fetchImpl: errorResponse(503) });
    submit(page, 'uncertain');
    await flush();
    page.$('optout-busy-cancel').click();
    assert.equal(page.$('optout-busy').hidden, true);
    assert.equal(page.$('optout-submit').disabled, false);
    assert.equal(page.$('optout-submit').textContent, 'Submit');
    assert.match(page.$('optout-submit-err').textContent, /hasn't been saved/);
    assert.equal(page.window.document.activeElement, page.$('optout-submit'));
    await sleep(1200);
    assert.equal(page.calls.length, 1, 'no retry after cancelling');
  });

  test(`gives up after ${MAX_BUSY_RETRIES} automatic retries and shows a "busy" message`, async () => {
    const page = await load({ script: FAST_RETRY_SCRIPT, fetchImpl: errorResponse(503) });
    submit(page, 'uncertain');
    await sleep(MAX_BUSY_RETRIES * 1100 + 300);
    await flush();
    assert.equal(page.calls.length, MAX_BUSY_RETRIES + 1);
    assert.equal(page.$('optout-busy').hidden, true);
    assert.match(page.$('optout-submit-err').textContent, /busy/);
    assert.equal(page.$('optout-submit').disabled, false);
  });

  test('ignores submits during the countdown', async () => {
    const page = await load({ fetchImpl: errorResponse(503) });
    submit(page, 'uncertain');
    await flush();
    submit(page);
    await flush();
    assert.equal(page.calls.length, 1);
    page.$('optout-busy-cancel').click();
  });
});

describe('opt-out.js: coming back after opting out', () => {
  test('shows the confirmation and a link to the I&E form, without redirecting', async () => {
    const page = await load({ stored: { [STORAGE_KEY]: '2026-10-20' } });
    assert.equal(page.$('optout-view-form').hidden, true);
    assert.equal(page.$('optout-view-done').hidden, false);
    assert.equal(page.$('optout-redirect-msg').hidden, true);
    assert.equal(page.$('optout-continue-msg').hidden, false);
    const link = new URL(page.$('optout-continue-link').href);
    assert.equal(link.searchParams.get('utm_id'), VALID_FCCID);
    assert.equal(link.searchParams.get('utm_term'), '2026-10-20', 'keeps the original submission date');
    await sleep(REDIRECT_DELAY_MS + 200);
    assert.equal(page.navigations.length, 0);
    page.window.close();
  });

  test('matches the account ID in any case', async () => {
    const page = await load({ query: `?utm_id=${VALID_FCCID.toUpperCase()}`, stored: { [STORAGE_KEY]: '2026-10-20' } });
    assert.equal(page.$('optout-view-done').hidden, false);
  });

  test('still shows the form for a different account', async () => {
    const page = await load({ stored: { 'aci-optout-done:00000000-0000-4000-8000-000000000000': '2026-10-20' } });
    assert.equal(page.$('optout-view-form').hidden, false);
  });

  test('works when sessionStorage is blocked', async () => {
    const page = await load({
      before: (window) => {
        Object.defineProperty(window, 'sessionStorage', { get() { throw new window.DOMException('blocked', 'SecurityError'); } });
      },
    });
    assert.equal(page.$('optout-view-form').hidden, false);
    submit(page, 'uncertain');
    await flush();
    assert.equal(page.$('optout-view-done').hidden, false);
    page.window.close();
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
