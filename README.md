# ACI Payment Opt-Out (embeddable form)

Form-only page, styled to match https://www.aciuk.co.uk/, designed to be embedded in an iframe on the ACI website. It lets a customer opt out of a payment amount change by choosing a reason. They are then sent to the Income & Expenditure form.

Hosted on Azure Static Web Apps: static files in `public/`, plus a managed Azure Function in `api/` that proxies to the OptOut API so the API key never reaches the browser.

```
browser ──POST /api/opt-out { FCCID, Reason }──▶ api/ proxy Function ──+ x-functions-key──▶ Droog Media OptOut API
```

## Deploy (Azure portal)

1. Create a **Static Web App** (Free plan is enough) and connect it to this GitHub repo and branch. Build details: preset **Custom**, app location `public`, API location `api`, output location blank. Azure commits a GitHub Actions workflow that deploys on every push.
2. In the Static Web App, go to **Settings > Environment variables** and add:
   - `OPTOUT_API_URL` = `https://droogmediadev.azurewebsites.net/api/OptOut`
   - `OPTOUT_API_KEY` = the `x-functions-key`

The key lives only in those Azure settings. It must never go in the JS, a committed file, or git.

## Run locally

Needs [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) v4.

```
cp api/local.settings.example.json api/local.settings.json   # then put the key in it
npm install --prefix api
npx @azure/static-web-apps-cli start public --api-location api
```

Open http://localhost:4280/?FCCID=cd6aac64-4b86-491f-8f88-5f600da2ae0a. Submitting calls the real API.

## Files

- `public/index.html`: the form (reason picker, confirmation, "no account" message)
- `public/css/aci.css`: ACI theme tokens and form components
- `public/js/opt-out.js`: validation, submit, iframe height and redirect messages
- `public/staticwebapp.config.json`: Node version for the API, and headers (framing allowed only by `https://www.aciuk.co.uk`)
- `api/src/functions/optOut.js`: the proxy; checks the FCCID and reason, adds the key, forwards to the API
- `api/local.settings.example.json`: template for local settings (`local.settings.json` is git-ignored)
- `embed-snippet.html`: the code to hand to the website host

## Embedding

Give the website host `embed-snippet.html` and set `FORM_ORIGIN` in it to the Static Web App address (e.g. `https://<name>.azurestaticapps.net`, or a custom domain). The snippet:

- passes `?FCCID=` from the host page's URL into the iframe
- resizes the iframe to fit its content (the form posts `aci-optout:height` messages)
- sends the whole page to the I&E form after a successful opt-out (the form posts `aci-optout:redirect`; the snippet only follows URLs starting with `https://www.aciuk.co.uk/form-dd-ie`)

All links inside the form open in the host page (`<base target="_top">`). If the snippet's script isn't installed, the confirmation still shows a "continue to the form" link.

## Config

`public/js/opt-out.js`:

| Setting | Default | Purpose |
|---|---|---|
| `DEMO` | `false` | When `true`, no network calls; submitting always succeeds; shows a "Demo mode" note |
| `API_OPTOUT` | `/api/opt-out` | The proxy; `POST { FCCID, Reason }` |
| `IE_FORM_URL` | `https://www.aciuk.co.uk/form-dd-ie` | Redirect target after opt-out (`FCCID` is appended); set to `null` to stay on the confirmation |
| `REDIRECT_DELAY_MS` | `2500` | How long the confirmation shows before redirecting |
| `REQUEST_TIMEOUT_MS` | `15000` | How long to wait for the API before showing an error |
| `PARENT_ORIGIN` | `https://www.aciuk.co.uk` | The host page's origin; height and redirect messages are only sent there |

Proxy (Static Web App environment variables):

| Name | Purpose |
|---|---|
| `OPTOUT_API_URL` | OptOut API URL (currently the dev instance) |
| `OPTOUT_API_KEY` | `x-functions-key` |

Accepted reasons are listed in `ALLOWED_REASONS` in `api/src/functions/optOut.js` and must match the `<option>` values in `public/index.html`.

## Before going live

- Set `OPTOUT_API_KEY` in the Static Web App's environment variables
- Point `OPTOUT_API_URL` at the production API (it's the dev instance now)
- Set `FORM_ORIGIN` in `embed-snippet.html`, and `PARENT_ORIGIN` (plus `frame-ancestors` in `public/staticwebapp.config.json`) if the host page isn't on `www.aciuk.co.uk`
