(function () {
  'use strict';

  // ---- Config -----------------------------------------------------------
  // PHP proxy (api/opt-out.php) that adds the API key server-side.
  // The key is never in this file or sent to the browser.
  // Set per page with data-api on the .aci-optout element; this is the fallback.
  const DEFAULT_API_OPTOUT = '/api/opt-out.php'; // POST { FCCID, Reason }
  // While DEMO is true no network calls are made.
  const DEMO = false;
  const REDIRECT_DELAY_MS = 8000;
  const REQUEST_TIMEOUT_MS = 15000;
  // When the API is busy (HTTP 503), count down this long and try again, up to MAX_BUSY_RETRIES times.
  const BUSY_RETRY_S = 20;
  const MAX_BUSY_RETRIES = 3;
  // Existing ACI Income & Expenditure (Budget Calculator) form. Set to null to skip the redirect.
  const IE_FORM_URL = 'https://www.aciuk.co.uk/form-dd-ie';
  // Matomo campaign source for visits to the I&E form that come from this page.
  const UTM_SOURCE = 'upliftForm';
  // Remembers, for this browser tab, that an account has opted out (value: the submission date).
  const STORAGE_PREFIX = 'aci-optout-done:';

  // FCCIDs are always UUIDs; must match FCCID_PATTERN in api/opt-out.php.
  const FCCID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** AbortSignal.timeout() is missing before Safari/iOS 16, so build the signal by hand there. */
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
    if (typeof AbortController === 'undefined') return undefined;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  /** The customer's local date as YYYY-MM-DD. */
  function isoDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // sessionStorage can be missing or throw (private browsing, blocked storage); the form works without it.
  function readStored(key) {
    try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStored(key, value) {
    try { window.sessionStorage.setItem(key, value); } catch (e) { /* not remembered */ }
  }

  function init() {
    const root = document.querySelector('.aci-optout');
    if (!root) return;

    const API_OPTOUT = root.dataset.api || DEFAULT_API_OPTOUT;
    // The customer's link carries their FCCID as ?utm_id=<uuid>.
    const FCCID = (new URLSearchParams(location.search).get('utm_id') || '').trim();
    const storageKey = STORAGE_PREFIX + FCCID.toLowerCase();

    const $ = (id) => document.getElementById(id);

    $('optout-demo-note').hidden = !DEMO;

    // ---- Opt-out form -----------------------------------------------------
    const form = $('optout-form');
    const select = $('optout-reason');
    const reasonErr = $('optout-reason-err');
    const submitErr = $('optout-submit-err');
    const button = $('optout-submit');
    const busy = $('optout-busy');
    const busyCount = $('optout-busy-count');
    const busyCancel = $('optout-busy-cancel');

    if (!FCCID_PATTERN.test(FCCID)) {
      $('optout-view-form').hidden = true;
      $('optout-view-nolink').hidden = false;
      return;
    }

    /**
     * Where to send the customer after a successful opt-out.
     * Return a URL string to redirect to the Income & Expenditure form,
     * or null to stay on the confirmation message.
     */
    function getIncomeExpenditureUrl(fccid, submittedOn) {
      if (!IE_FORM_URL) return null;
      const url = new URL(IE_FORM_URL);
      // The reason is already stored by the opt-out API, so only the account ID is passed on,
      // plus the Matomo campaign parameters.
      url.searchParams.set('FCCID', fccid);
      url.searchParams.set('utm_id', fccid);
      url.searchParams.set('utm_source', UTM_SOURCE);
      url.searchParams.set('utm_term', submittedOn);
      return url.toString();
    }

    // Already opted out in this tab (Back from the I&E form, or a refresh): show the confirmation with a
    // link, but don't redirect again, or Back would bounce the customer straight forward.
    const doneOn = readStored(storageKey);
    if (doneOn) {
      $('optout-view-form').hidden = true;
      $('optout-view-done').hidden = false;
      const url = getIncomeExpenditureUrl(FCCID, doneOn);
      if (url) {
        $('optout-continue-link').href = url;
        $('optout-continue-msg').hidden = false;
      }
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
        signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
      return res.json().catch(() => ({ ok: true }));
    }

    function showDone(redirectUrl) {
      $('optout-view-form').hidden = true;
      $('optout-view-done').hidden = false;
      $('optout-done-title').focus();
      if (redirectUrl) {
        // The link stays on screen in case the redirect is slow or the customer wants to go now.
        $('optout-redirect-link').href = redirectUrl;
        $('optout-redirect-msg').hidden = false;
        setTimeout(() => location.assign(redirectUrl), REDIRECT_DELAY_MS);
      }
    }

    function resetButton() {
      button.disabled = false;
      button.textContent = 'Submit';
    }

    function showError(message) {
      submitErr.textContent = message;
      submitErr.hidden = false;
    }

    // ---- API busy: count down, then try again, unless the customer cancels ----
    let busyRetries = 0;
    let countdown = null;

    function stopCountdown() {
      clearInterval(countdown);
      countdown = null;
      busy.hidden = true;
    }

    function startCountdown() {
      let remaining = BUSY_RETRY_S;
      busyCount.textContent = String(remaining);
      button.textContent = 'Submit';
      busy.hidden = false;
      busyCancel.focus();
      countdown = setInterval(() => {
        remaining -= 1;
        busyCount.textContent = String(remaining);
        if (remaining <= 0) {
          stopCountdown();
          attempt();
        }
      }, 1000);
    }

    busyCancel.addEventListener('click', () => {
      stopCountdown();
      resetButton();
      showError("Your choice hasn't been saved. Press Submit when you're ready to try again, or contact us.");
      button.focus();
    });

    async function attempt() {
      submitErr.hidden = true;

      const reason = select.value;
      if (!reason) {
        resetButton();
        setReasonError(true);
        select.focus();
        return;
      }

      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        await submitOptOut(reason);
        const submittedOn = isoDate(new Date());
        writeStored(storageKey, submittedOn);
        showDone(getIncomeExpenditureUrl(FCCID, submittedOn));
      } catch (err) {
        if (err.status === 503 && busyRetries < MAX_BUSY_RETRIES) {
          busyRetries += 1;
          startCountdown();
          return;
        }
        resetButton();
        showError(err.status === 429
          ? 'Too many attempts. Please wait a few minutes and try again, or contact us.'
          : err.status === 503
            ? "We're very busy right now. Please wait a minute and try again, or contact us."
            : "We couldn't save your choice. Please try again or contact us.");
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (countdown || button.disabled) return;
      busyRetries = 0;
      attempt();
    });
  }

  // The page builder may put this script before or after the form markup.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
