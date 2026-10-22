# ACI Payment Opt-Out (embeddable form)

Form-only page, styled to match https://www.aciuk.co.uk/, designed to be embedded in an iframe on any site. It lets a customer opt out of a payment amount change by choosing a reason. They are then sent to the Income & Expenditure form.

Static files plus one PHP script in `public/`. The script proxies to the OptOut API so the API key never reaches the browser.

```
browser ──HTTPS POST api/opt-out.php { FCCID, Reason }──▶ PHP proxy ──+ x-functions-key──▶ OptOut API
```

## What the proxy checks

A browser can't hold a secret, so the payload's protection comes from the proxy rather than from signing in the browser:

- HTTPS only (plain HTTP is refused, except for genuine local connections)
- `Origin` must be this site, or one listed in `allowed_origins`, which blocks other sites posting on a customer's behalf
- POST, `application/json`, at most 2 KB
- `FCCID` must be a UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, hex, any case); `Reason` must be one of the allowed values
- Rate limit per IP address, or per /64 for IPv6 (default 10 attempts per 10 minutes, then HTTP 429)
- Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) are only believed from proxies listed in `trusted_proxies`
- PHP errors are never shown to the browser, and responses carry restrictive security headers
- The key is added on the server, sent to the API over verified TLS, and never returned or logged
- Errors from the API are logged by status code only; the browser gets a generic failure

## Deploy

Needs PHP 7.4+ (8.1 or later recommended; older versions no longer get security fixes) with the `curl` extension, served over HTTPS.

1. Upload the contents of `public/` to the web root (it includes `api/opt-out.php` and an Apache `.htaccess`).
2. Copy `optout-config.example.php` to `optout-config.php` **one level above the web root** and fill in `api_key`.
   Or set the environment variables `OPTOUT_API_URL` and `OPTOUT_API_KEY` (these win over the file), or point `OPTOUT_CONFIG` at the config file's path.

The key lives only in that file or those variables. It must never go in the JS, a file inside the web root, or git (`optout-config.php` is git-ignored).

On nginx, `.htaccess` is ignored: set the headers from it in the server block, and make sure `.php` files are passed to PHP-FPM.

## Run locally

```
cp optout-config.example.php optout-config.php   # then put the key in it
php -S localhost:8080 -t public
```

Open http://localhost:8080/?FCCID=<test account id>. Submitting calls the real API.

## Files

- `public/index.html`: the form (reason picker, confirmation, "no account" message)
- `public/css/aci.css`: ACI theme tokens and form components
- `public/js/opt-out.js`: validation, submit and redirect
- `public/api/opt-out.php`: the proxy; checks the request, adds the key, forwards to the API
- `public/.htaccess`: security headers (including a Content-Security-Policy) and no directory listings (Apache)
- `optout-config.example.php`: template for the proxy settings (keep the real one outside the web root)

## Embedding

Use a plain iframe pointing at the site the form is deployed to, with the customer's account ID in the query string:

```html
<iframe src="https://<form-address>/?FCCID=<account id>"
        title="Opt out of your payment change"
        style="width: 100%; height: 640px; border: 0;"></iframe>
```

- The iframe doesn't resize itself, so give it a fixed height that fits the form (around 640px).
- Links inside the form open in the top page, not the iframe (`<base target="_top">`).
- After a successful opt-out the form tries to send the whole page to the I&E form. Some browsers block a cross-origin iframe from doing that, so the confirmation also shows a "continue to the form" link.
- Any site can embed the form. To restrict this, add `frame-ancestors <allowed origins>` to the Content-Security-Policy in `public/.htaccess`.

## Config

`public/js/opt-out.js`:

| Setting | Default | Purpose |
|---|---|---|
| `DEMO` | `false` | When `true`, no network calls; submitting always succeeds; shows a "Demo mode" note |
| `API_OPTOUT` | `api/opt-out.php` | The proxy; `POST { FCCID, Reason }`. Can be a full URL on another site (add this site to that proxy's `allowed_origins`) |
| `IE_FORM_URL` | `https://www.aciuk.co.uk/form-dd-ie` | Redirect target after opt-out (`FCCID` is appended); set to `null` to stay on the confirmation |
| `REDIRECT_DELAY_MS` | `2500` | How long the confirmation shows before redirecting |
| `REQUEST_TIMEOUT_MS` | `15000` | How long to wait for the API before showing an error |

`optout-config.php` (or environment variables):

| Setting | Env variable | Purpose |
|---|---|---|
| `api_url` | `OPTOUT_API_URL` | OptOut API URL, must be `https://` (currently the dev instance) |
| `api_key` | `OPTOUT_API_KEY` | `x-functions-key` |
| `allowed_origins` | | Other sites allowed to call the proxy from the browser |
| `rate_limit_max` / `rate_limit_window_s` | | Attempts allowed per IP per window (default 10 per 600s) |
| `trusted_proxies` | | IPs or CIDR ranges of a CDN/proxy in front of the site; forwarded headers are only trusted from these |
| `client_ip_header` | | Where the trusted proxy puts the real client IP (default `HTTP_X_FORWARDED_FOR`; Cloudflare: `HTTP_CF_CONNECTING_IP`) |

Accepted reasons are listed in `ALLOWED_REASONS` in `public/api/opt-out.php` and must match the `<option>` values in `public/index.html`.

## Before going live

- Put the key in `optout-config.php` (outside the web root) or the environment variables
- Point `api_url` at the production API (it's the dev instance now)
- Check that opening `https://<form-address>/api/opt-out.php` in a browser is refused (403 `origin_not_allowed`), and that no copy of `optout-config.php` is inside the web root
- If the site is behind a proxy or CDN, set `trusted_proxies` (and `client_ip_header`), or every customer shares one rate limit
- See `SECURITY_AUDIT_REPORT.md` for the items that need action outside the code
