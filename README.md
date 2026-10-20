# ACI Payment Opt-Out (dev page)

Static page styled to match https://www.aciuk.co.uk/. It lets a customer opt out of a payment amount change by choosing a reason. They are then sent to the Income & Expenditure form.

## Run locally

```
python -m http.server 8080
```

Open http://localhost:8080/?FCCID=12345. Any static host works (IIS, nginx, S3, `npx serve`).

## Files

- `index.html`: the page (ACI header, hero, opt-out form, footer)
- `css/aci.css`: ACI theme tokens and components, using the live breakpoints (1200 / 960 / 660px)
- `js/opt-out.js`: menus, validation, submit and redirect

Images and logos are loaded directly from aciuk.co.uk.

## Config (top of `js/opt-out.js`)

| Setting | Default | Purpose |
|---|---|---|
| `DEMO` | `true` | No network calls; submitting always succeeds |
| `API_OPTOUT` | `/api/opt-out` | `POST { fccid, reason }` |
| `IE_FORM_URL` | `https://www.aciuk.co.uk/form-dd-ie` | Redirect target after opt-out (`FCCID` is appended); set to `null` to stay on the confirmation |
| `REDIRECT_DELAY_MS` | `2500` | How long the confirmation shows before redirecting |

## Before going live

- Replace the placeholder reasons ("Reason 1"–"Reason 4") in `index.html`
- Set `DEMO = false` and point `API_OPTOUT` at the real endpoint
- Remove the "Development preview" banner and the `has-dev-banner` class on `<body>`
