(function () {
  'use strict';

  // ---- Config -----------------------------------------------------------
  // Point API_OPTOUT at the real endpoint. While DEMO is true no network calls are made.
  const API_OPTOUT = '/api/opt-out'; // POST { fccid, reason }
  const DEMO = true;
  const REDIRECT_DELAY_MS = 2500;
  // Existing ACI Income & Expenditure (Budget Calculator) form. Set to null to skip the redirect.
  const IE_FORM_URL = 'https://www.aciuk.co.uk/form-dd-ie';

  const params = new URLSearchParams(location.search);
  const FCCID = params.get('FCCID') || params.get('fccid') || '';

  const $ = (id) => document.getElementById(id);

  // ---- Header + slide-down panels ---------------------------------------
  const header = $('header');
  const overlay = $('overlay');
  let openPanel = null;

  function setPanel(panel) {
    if (openPanel) {
      openPanel.classList.remove('is-open');
      document.querySelector('[aria-controls="' + openPanel.id + '"]').setAttribute('aria-expanded', 'false');
    }
    openPanel = panel;
    overlay.classList.toggle('is-open', !!panel);
    if (panel) {
      panel.classList.add('is-open');
      document.querySelector('[aria-controls="' + panel.id + '"]').setAttribute('aria-expanded', 'true');
      panel.querySelector('a, button').focus();
    }
  }

  document.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => setPanel($(btn.dataset.open)));
  });
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => setPanel(null));
  });
  overlay.addEventListener('click', () => setPanel(null));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPanel) setPanel(null); });

  // The dev banner pushes the floating header down; snap it back once the banner scrolls away.
  window.addEventListener('scroll', () => {
    header.classList.toggle('is-scrolled', window.scrollY > 48);
  }, { passive: true });

  // ---- Opt-out form -------------------------------------------------------
  const form = $('optout-form');
  const select = $('optout-reason');
  const reasonErr = $('reason-err');
  const submitErr = $('submit-err');
  const button = $('btn-optout');

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
      body: JSON.stringify({ fccid: FCCID, reason: reason }),
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

  function showDone(redirectUrl) {
    $('view-form').hidden = true;
    $('view-done').hidden = false;
    $('done-title').focus();
    if (redirectUrl) {
      $('redirect-msg').hidden = false;
      setTimeout(() => { location.href = redirectUrl; }, REDIRECT_DELAY_MS);
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
