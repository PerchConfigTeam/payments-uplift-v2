# ACI Payment Opt-Out form

A form styled to match https://www.aciuk.co.uk/, placed directly in a page on that site. It lets a customer opt out of a payment amount change by choosing a reason. They are then sent to the Income & Expenditure form.

An HTML block, one stylesheet and one script, plus a PHP script that proxies to the OptOut API so the API key never reaches the browser.

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

1. Upload `public/api/opt-out.php` so it's served at `/api/opt-out.php` (or anywhere else; see `data-api` below). `public/.htaccess` adds security headers on Apache. `public/index.html` is a standalone test page and doesn't need to go live.
2. Copy `optout-config.example.php` to `optout-config.php` **one level above the web root** and fill in `api_key`.
   Or set the environment variables `OPTOUT_API_URL` and `OPTOUT_API_KEY` (these win over the file), or point `OPTOUT_CONFIG` at the config file's path.

The key lives only in that file or those variables. It must never go in the JS, a file inside the web root, or git (`optout-config.php` is git-ignored).

On nginx, `.htaccess` is ignored: set the headers from it in the server block, and make sure `.php` files are passed to PHP-FPM.

## Run locally

```
cp optout-config.example.php optout-config.php   # then put the key in it
php -S localhost:8080 -t public
```

Open http://localhost:8080/?utm_id=<test account id>. Submitting calls the real API.

## Files

- `public/index.html`: standalone test page containing the form block to paste into the live page (reason picker, confirmation, "no account" message)
- `public/css/aci.css`: ACI theme tokens and form components
- `public/js/opt-out.js`: validation, submit and redirect
- `public/api/opt-out.php`: the proxy; checks the request, adds the key, forwards to the API
- `public/.htaccess`: security headers (including a Content-Security-Policy) and no directory listings (Apache)
- `optout-config.example.php`: template for the proxy settings (keep the real one outside the web root)

## Adding the form to a page

1. Load `css/aci.css` and `js/opt-out.js` on the page (enqueue them in WordPress, or add `<link>`/`<script defer>` tags). The script can go before or after the form.
2. Paste the block between the `Copy from here` / `Copy to here` comments in `public/index.html` into the page.
3. Set `data-api` on the `<div class="aci-optout">` to the proxy's URL. The default is `/api/opt-out.php` on the same site.
4. Link customers to the page with their account ID (FCCID) in the `utm_id` query parameter, e.g. `https://www.aciuk.co.uk/<page>/?utm_id=<account id>`.

Notes:

- Every style is scoped to `.aci-optout`, and every element ID starts with `optout-`, so the form doesn't affect the rest of the page. The theme's own styles for `.aci-form1` and `.tyButton` still apply inside it, and the form's styles mirror them.
- The page uses the theme's Space Grotesk and Nunito fonts. The test page loads them from Google Fonts itself.
- Set the page to `noindex` (e.g. in the SEO plugin), so the page doesn't appear in search results.
- The account ID is in the page URL as `utm_id` so that Matomo can attribute visits to it. Matomo records it as the campaign ID, so only give access to Matomo reports to staff who need it (VULN-010 in `SECURITY_AUDIT_REPORT.md`, risk accepted).
- If the proxy is on a different site from the page, add the page's origin (e.g. `https://www.aciuk.co.uk`) to `allowed_origins`. If the page's site sends a Content-Security-Policy, its `connect-src` must allow the proxy.

## Config

On the page, `data-api` on `.aci-optout`: the proxy; `POST { FCCID, Reason }`. Defaults to `/api/opt-out.php`. Can be a full URL on another site (add the page's origin to that proxy's `allowed_origins`).

`public/js/opt-out.js`:

| Setting | Default | Purpose |
|---|---|---|
| `DEMO` | `false` | When `true`, no network calls; submitting always succeeds; shows a "Demo mode" note |
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

Accepted reasons are listed in `ALLOWED_REASONS` in `public/api/opt-out.php` and must match the `<option>` values in the form.

## Before going live

- Put the key in `optout-config.php` (outside the web root) or the environment variables
- Point `api_url` at the production API (it's the dev instance now)
- Check that opening `https://<form-address>/api/opt-out.php` in a browser is refused (403 `origin_not_allowed`), and that no copy of `optout-config.php` is inside the web root
- If the site is behind a proxy or CDN, set `trusted_proxies` (and `client_ip_header`), or every customer shares one rate limit
- See `SECURITY_AUDIT_REPORT.md` for the items that need action outside the code
