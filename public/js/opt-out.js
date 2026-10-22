(function () {
  'use strict';

  // ---- Config -----------------------------------------------------------
  // Same-origin proxy (api/src/functions/optOut.js) that adds the API key server-side.
  // The key is never in this file or sent to the browser.
  const API_OPTOUT = '/api/opt-out'; // POST { FCCID, Reason }
  // While DEMO is true no network calls are made.
  const DEMO = false;
  const REDIRECT_DELAY_MS = 2500;
  const REQUEST_TIMEOUT_MS = 15000;
  // Existing ACI Income & Expenditure (Budget Calculator) form. Set to null to skip the redirect.
  const IE_FORM_URL = 'https://www.aciuk.co.uk/form-dd-ie';
  // Origin of the page that embeds this form. Messages to the parent (height, redirect) only go here.
  const PARENT_ORIGIN = 'https://www.aciuk.co.uk';

  const params = new URLSearchParams(location.search);
  const FCCID = params.get('FCCID') || params.get('fccid') || '';

  const $ = (id) => document.getElementById(id);
  const embedded = window.parent !== window;

  function postToParent(message) {
    if (embedded) window.parent.postMessage(message, PARENT_ORIGIN);
  }

  // ---- Iframe auto-height -----------------------------------------------
  // The host page listens for this and sets the iframe height, so there is no inner scrollbar.
  function sendHeight() {
    postToParent({ type: 'aci-optout:height', height: document.documentElement.scrollHeight });
  }
  new ResizeObserver(sendHeight).observe(document.body);
  window.addEventListener('load', sendHeight);

  $('demo-note').hidden = !DEMO;

  // ---- Opt-out form -------------------------------------------------------
  const form = $('optout-form');
  const select = $('optout-reason');
  const reasonErr = $('reason-err');
  const submitErr = $('submit-err');
  const button = $('btn-optout');

  if (!FCCID) {
    $('view-form').hidden = true;
    $('view-nolink').hidden = false;
    return;
  }

  function setReasonError(on) {
    select.classList.toggle('form-error', on);
    select.setAttribute('aria-invalid', on ? 'true' : 'false');
    reasonErr.hidden = !on;
  }

  select.addEventListener('change', () => setReasonError(false));

  async function submitOptOut(reason) {
    if (DEMO) return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 600));
    const res = await fetch(API_OPTOUT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FCCID: FCCID, Reason: reason }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json().catch(() => ({ ok: true }));
  }

  /**
   * Where to send the customer after a successful opt-out.
   * Return a URL string to redirect to the Income & Expenditure form,
   * or null to stay on the confirmation message.
   */
  function getIncomeExpenditureUrl(fccid) {
    if (!IE_FORM_URL) return null;
    const url = new URL(IE_FORM_URL);
    // The reason is already stored by the opt-out API, so only the account ID is passed on.
    if (fccid) url.searchParams.set('FCCID', fccid);
    return url.toString();
  }

  // The redirect must move the whole host page, not just the iframe.
  // Ask the host page to do it; if this page isn't embedded, navigate directly.
  function redirectTop(url) {
    if (embedded) {
      postToParent({ type: 'aci-optout:redirect', url: url });
    } else {
      location.href = url;
    }
  }

  function showDone(redirectUrl) {
    $('view-form').hidden = true;
    $('view-done').hidden = false;
    $('done-title').focus({ preventScroll: true });
    if (redirectUrl) {
      $('redirect-link').href = redirectUrl;
      $('redirect-msg').hidden = false;
      setTimeout(() => redirectTop(redirectUrl), REDIRECT_DELAY_MS);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitErr.hidden = true;

    const reason = select.value;
    if (!reason) {
      setReasonError(true);
      select.focus();
      return;
    }

    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await submitOptOut(reason);
      showDone(getIncomeExpenditureUrl(FCCID));
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Opt out';
      submitErr.textContent = "We couldn't save your choice. Please try again or contact us.";
      submitErr.hidden = false;
    }
  });
})();
