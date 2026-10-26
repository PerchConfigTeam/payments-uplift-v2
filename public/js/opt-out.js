(function () {
  'use strict';

  // ---- Config -----------------------------------------------------------
  // PHP proxy (api/opt-out.php) that adds the API key server-side.
  // The key is never in this file or sent to the browser.
  // Set per page with data-api on the .aci-optout element; this is the fallback.
  const DEFAULT_API_OPTOUT = '/api/opt-out.php'; // POST { FCCID, Reason }
  // While DEMO is true no network calls are made.
  const DEMO = false;
  const REDIRECT_DELAY_MS = 5000;
  const REQUEST_TIMEOUT_MS = 15000;
  // Existing ACI Income & Expenditure (Budget Calculator) form. Set to null to skip the redirect.
  const IE_FORM_URL = 'https://www.aciuk.co.uk/form-dd-ie';

  // FCCIDs are always UUIDs; must match FCCID_PATTERN in api/opt-out.php.
  const FCCID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function init() {
    const root = document.querySelector('.aci-optout');
    if (!root) return;

    const API_OPTOUT = root.dataset.api || DEFAULT_API_OPTOUT;
    // The customer's link carries their FCCID as ?utm_id=<uuid>.
    const FCCID = (new URLSearchParams(location.search).get('utm_id') || '').trim();

    const $ = (id) => document.getElementById(id);

    $('optout-demo-note').hidden = !DEMO;

    // ---- Opt-out form -----------------------------------------------------
    const form = $('optout-form');
    const select = $('optout-reason');
    const reasonErr = $('optout-reason-err');
    const submitErr = $('optout-submit-err');
    const button = $('optout-submit');

    if (!FCCID_PATTERN.test(FCCID)) {
      $('optout-view-form').hidden = true;
      $('optout-view-nolink').hidden = false;
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
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
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
        submitErr.textContent = err.status === 429
          ? 'Too many attempts. Please wait a few minutes and try again, or contact us.'
          : err.status === 503
            ? "We're very busy right now. Please wait a minute and try again, or contact us."
            : "We couldn't save your choice. Please try again or contact us.";
        submitErr.hidden = false;
      }
    });
  }

  // The page builder may put this script before or after the form markup.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
