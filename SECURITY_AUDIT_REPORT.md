# 🔐 Security Audit Report

**Project:** payments-uplift-v2 (ACI Payment Opt-Out form)
**Audit Date:** 2026-10-22
**Auditor:** Claude Security Audit Skill
**Scope:** `public/index.html`, `public/js/opt-out.js`, `public/css/aci.css`, `public/api/opt-out.php`, `public/.htaccess`, `optout-config.example.php`, `optout-config.php` (local, git-ignored), `.gitignore`, git history (2 commits). The untracked `dist/` folder (an old build) was reviewed but not changed.
**Tech Stack:** Static HTML/CSS/vanilla JavaScript, PHP 7.4+ proxy using cURL, Apache `.htaccess`. No package dependencies.

---

## Executive Summary

| Severity | Found | Fixed / Resolved | Risk Accepted | Remaining |
|----------|-------|-------|-------|-----------|
| 🔴 Critical | 0 | 0 | 0 | 0 |
| 🟠 High | 1 | 0 | 1 | 0 |
| 🟡 Medium | 2 | 2 | 0 | 0 |
| 🔵 Low | 9 | 7 | 1 | 1 |
| ⚪ Info | 3 | 2 | 0 | 1 |
| **Total** | **15** | **11** | **2** | **2** |

The code is small and well structured. It has no injection, XSS, SSRF or open-redirect paths. The API key stays on the server, is git-ignored, and has never been committed. The most important remaining issue is a design question rather than a code bug: **the customer's account ID (FCCID) is the only thing needed to opt that customer out**, so anyone who learns or guesses one can act for them. Closing that needs signed links from the system that sends customers their messages, which that platform can't support, so **the business has accepted this risk** (see VULN-001). The code fixes in this audit harden the rate limiter, the trust of proxy headers, error output and response headers.

**Update 2026-10-22 (after review):** VULN-001 risk accepted. VULN-011 resolved (the API's response format is fixed, so the 2xx check is correct). VULN-015 fixed (`dist/` deleted). Key rotation (VULN-012) and site-wide HSTS (VULN-009) are scheduled; they stay open until done.

**Update 2026-10-23:** The form now goes straight into a page on the ACI site instead of an iframe. VULN-008 is fixed (`frame-ancestors 'none'`). VULN-010 matters more now: the `FCCID` is in the URL of a page that runs the site's analytics, so it must be excluded there. The URL parameter has since been renamed to `utm_id` so that Matomo can attribute visits to it. The business has accepted this risk (VULN-010): FCCIDs are UUIDs and can't realistically be guessed, and Matomo is only open to ACI staff.

**Update 2026-10-26:** VULN-009 fixed: HSTS is now enabled site-wide on the WordPress site.

All PHP changes were syntax-checked with `php -l`. The new IP and proxy helpers passed 17 unit checks. An end-to-end run against a local test server with a fake config confirmed the origin, method, content-type, CORS, header and rate-limit behaviour. The real API was not called.

---

## Findings & Remediations

### 🟠 [VULN-001] Account ID is the only credential for opting out

| Field | Value |
|-------|-------|
| **Severity** | High |
| **Category** | Broken Access Control (A01) |
| **File(s)** | `public/api/opt-out.php:237-244`, `public/js/opt-out.js:15-18` |
| **CWE** | CWE-639 (Authorization Bypass Through User-Controlled Key), CWE-306 |
| **Status** | 🟰 Risk Accepted (2026-10-22) |

**Description**
The proxy forwards any well-formed `{ FCCID, Reason }` with the API key attached. Nothing proves that the person submitting is the customer that FCCID belongs to. The Origin check stops other websites from doing this through a customer's browser, but a script (curl, Python) can set any `Origin` header it likes. Anyone who has an FCCID, from a forwarded message, browser history, analytics logs or a guess, can opt that account out and send it down the I&E path. FCCIDs are UUIDs, and the proxy now accepts only UUIDs (see compensating control 1), so guessing a valid one is impractical. The realistic risk is an FCCID leaking.

**Vulnerable Code (Before)**
```php
$fccid = is_string($body['FCCID'] ?? null) ? trim($body['FCCID']) : '';
// ...validated for format only, then forwarded with the key
```

**Fixed Code (After)**
Not changed. A real fix needs the link-sending system to sign the link, for example `?FCCID=…&exp=…&sig=HMAC(secret, FCCID|exp)`. The proxy would then verify the signature and expiry with a shared secret before forwarding.

**Risk acceptance**
The message-sending platform can't generate signed links, so the business accepted this risk on 2026-10-22. Revisit it if the platform changes, if FCCIDs start being exposed more widely, or if unexpected opt-outs are reported.

**Mitigation**
Partly mitigated today by the Origin check (blocks cross-site requests from browsers), the per-IP rate limit (slows guessing) and strict format validation. Compensating controls that don't need the message platform:
1. ✅ **Done 2026-10-22:** `FCCID_PATTERN` (`public/api/opt-out.php:22`) now accepts only UUIDs, so only IDs from a space far too large to guess get through. The form also checks the format, and shows "We couldn't find your account" for a malformed link.
2. Keep the rate limit in place and set `trusted_proxies` correctly in production (VULN-002).
3. Watch the opt-out volume in the OptOut API or server logs, and investigate spikes or many opt-outs from one IP.
4. Limit who can view Matomo reports (VULN-010). FCCIDs are recorded there deliberately as `utm_id`, so Matomo is the most likely place for them to leak in bulk.

---

### 🟡 [VULN-002] Rate limit is shared behind a proxy and bypassable over IPv6

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **Category** | Rate Limiting |
| **File(s)** | `public/api/opt-out.php:98-108`, `:130-137`, `:219` |
| **CWE** | CWE-770 (Allocation of Resources Without Limits or Throttling) |
| **Status** | ✅ Fixed (needs `trusted_proxies` set when deployed behind a CDN/proxy) |

**Description**
The limiter counted requests per `REMOTE_ADDR`. This went wrong in two ways:
- **Behind a CDN or load balancer** (common on WordPress hosts), `REMOTE_ADDR` is the proxy's address. Every customer would then share one limit of 10 attempts per 10 minutes, which locks genuine customers out.
- **Over IPv6**, a single client typically controls a whole /64 block (18 quintillion addresses). It could change address on every request and never hit the limit.

**Vulnerable Code (Before)**
```php
if (rate_limited((string) ($_SERVER['REMOTE_ADDR'] ?? ''), $config['rate_limit_max'], $config['rate_limit_window_s'])) {
```

**Fixed Code (After)**
```php
function client_ip(array $config): string
{
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (!from_trusted_proxy($config)) {
        return $remote;
    }
    // The last X-Forwarded-For entry is the one our trusted proxy added.
    $parts = array_map('trim', explode(',', (string) ($_SERVER[$config['client_ip_header']] ?? '')));
    $candidate = (string) end($parts);
    return filter_var($candidate, FILTER_VALIDATE_IP) ? $candidate : $remote;
}

function rate_limit_key(string $ip): string
{
    $bin = @inet_pton($ip);
    if ($bin !== false && strlen($bin) === 16) {
        return 'v6:' . bin2hex(substr($bin, 0, 8));
    }
    return $ip;
}
// ...
if (rate_limited(rate_limit_key(client_ip($config)), $config['rate_limit_max'], $config['rate_limit_window_s'])) {
```

**Mitigation**
The real client IP is read from the forwarding header only when the connection comes from a proxy listed in the new `trusted_proxies` setting. Anyone else's forwarding header is ignored, so attackers can't spoof their IP. IPv6 clients are grouped by /64. Set `trusted_proxies` (and `client_ip_header`, e.g. `HTTP_CF_CONNECTING_IP` for Cloudflare) in `optout-config.php` when deploying behind a proxy.

---

### 🟡 [VULN-003] Unbounded growth of rate-limit files

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **Category** | Rate Limiting / Resource Exhaustion |
| **File(s)** | `public/api/opt-out.php:143-179` |
| **CWE** | CWE-770 |
| **Status** | ✅ Fixed |

**Description**
Every distinct client created a file in the temp directory, and nothing ever deleted them. A flood of requests from many addresses, which is trivial over IPv6 before VULN-002 was fixed, could fill the disk or run out of inodes on a shared host.

**Vulnerable Code (Before)**
```php
$fh = @fopen($dir . '/' . hash('sha256', $ip), 'c+');
// files were never removed
```

**Fixed Code (After)**
```php
// Occasionally delete files for clients not seen this window, so the directory can't grow without limit.
if (random_int(1, 100) === 1) {
    foreach (glob($dir . '/*') ?: [] as $file) {
        if (@filemtime($file) < time() - $windowSeconds) {
            @unlink($file);
        }
    }
}
```

**Mitigation**
About 1 in 100 requests sweeps out counters older than the rate-limit window. Combined with /64 grouping, the number of files now stays in proportion to the number of genuine recent clients.

---

### 🔵 [VULN-004] `X-Forwarded-Proto` trusted from any client

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Security Misconfiguration (A05) |
| **File(s)** | `public/api/opt-out.php:110-118` |
| **CWE** | CWE-348 (Use of Less Trusted Source), CWE-319 |
| **Status** | ✅ Fixed |

**Description**
The HTTPS-only check accepted `X-Forwarded-Proto: https` from anyone. A client could send that header over plain HTTP to skip the check, which undermines the guarantee that payloads only ever travel over TLS.

**Vulnerable Code (Before)**
```php
return strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
```

**Fixed Code (After)**
```php
return from_trusted_proxy($config)
    && strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
```

**Mitigation**
The header is believed only when the request arrives directly from a configured trusted proxy.

---

### 🔵 [VULN-005] Localhost HTTPS exemption reachable with a spoofed Host header

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Security Misconfiguration (A05) |
| **File(s)** | `public/api/opt-out.php:120-127` |
| **CWE** | CWE-348, CWE-319 |
| **Status** | ✅ Fixed |

**Description**
Plain HTTP was allowed whenever the `Host` header said `localhost`. On a production server, a request carrying `Host: localhost` could therefore be accepted over HTTP.

**Vulnerable Code (Before)**
```php
$host = strtolower(preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
return in_array($host, ['localhost', '127.0.0.1', '[::1]'], true);
```

**Fixed Code (After)**
```php
$host = strtolower(preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
$remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
return in_array($host, ['localhost', '127.0.0.1', '[::1]'], true)
    && in_array($remote, ['127.0.0.1', '::1'], true);
```

**Mitigation**
The exemption now also needs the TCP connection itself to come from the loopback address, which a remote client can't fake.

---

### 🔵 [VULN-006] PHP errors could be displayed to the browser

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Security Misconfiguration (A05) |
| **File(s)** | `public/api/opt-out.php:16-17` |
| **CWE** | CWE-209 (Error Message Containing Sensitive Information) |
| **Status** | ✅ Fixed |

**Description**
Many shared and WordPress hosts run with `display_errors=On`. A warning or fatal error, such as a broken `optout-config.php`, would then print server paths into the response.

**Vulnerable Code (Before)**
```php
declare(strict_types=1);
// (no error display control)
```

**Fixed Code (After)**
```php
declare(strict_types=1);

// Never print PHP warnings or paths to the browser; they still go to the error log.
ini_set('display_errors', '0');
```

**Mitigation**
Errors are kept out of responses whatever the host's `php.ini` says, and are still written to the server error log.

---

### 🔵 [VULN-007] Missing Content-Security-Policy and Permissions-Policy

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Missing Security Headers |
| **File(s)** | `public/.htaccess:4-12`, `public/api/opt-out.php:32` |
| **CWE** | CWE-693 (Protection Mechanism Failure) |
| **Status** | ✅ Fixed (Apache only; nginx hosts must copy the headers) |

**Description**
The page had no CSP, so any future injection bug would run with full privileges. The JSON responses didn't restrict rendering either.

**Vulnerable Code (Before)**
```apache
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "strict-origin"
Header always set X-Robots-Tag "noindex, nofollow"
```

**Fixed Code (After)**
```apache
Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"
Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'"
```
```php
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
```

**Mitigation**
Only same-origin scripts, styles and API calls are allowed, plus Google Fonts and the inline SVG `data:` image used by the select arrow. The page has no inline scripts or styles, so nothing breaks. These headers cover the test page and the files served from this folder. The live form runs inside a WordPress page, so that site's own CSP (if any) applies there and must allow the proxy in `connect-src`.

---

### 🔵 [VULN-008] Form can be framed by any site (clickjacking)

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Missing Security Headers |
| **File(s)** | `public/.htaccess:9-11` |
| **CWE** | CWE-1021 (Improper Restriction of Rendered UI Layers or Frames) |
| **Status** | ✅ Fixed (2026-10-23: the form is no longer framed) |

**Description**
There's no `frame-ancestors` directive, which was a deliberate choice so the form can be embedded on any site. A hostile page could frame it and trick a customer into clicking. The impact is limited because the attacker would also need the customer's FCCID, and with that they could call the API directly (VULN-001).

**Mitigation**
The form now goes straight into a page on the ACI site, so nothing needs to frame it. `frame-ancestors 'none'` is added to the CSP in `public/.htaccess`. Framing of the live page itself is controlled by the WordPress site's own headers.

---

### 🔵 [VULN-009] No HSTS header

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Cryptographic Failures (A02) |
| **File(s)** | `public/.htaccess` |
| **CWE** | CWE-319 (Cleartext Transmission of Sensitive Information) |
| **Status** | ✅ Fixed (2026-10-26: HSTS enabled site-wide on the WordPress site) |

**Description**
Without `Strict-Transport-Security`, a customer's first visit could be downgraded to HTTP by someone on their network. The proxy refuses plain-HTTP submissions, but the page itself could still be served over HTTP.

**Mitigation**
HSTS applies to the whole hostname, so it shouldn't be set from a subfolder of a shared WordPress site without the site owner agreeing. Ask the host to enable HSTS site-wide (e.g. `max-age=31536000`).

---

### 🔵 [VULN-010] Account ID carried in the URL query string

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Sensitive Data Exposure |
| **File(s)** | `public/js/opt-out.js:24`, `:73` |
| **CWE** | CWE-598 (Use of GET Request Method With Sensitive Query Strings) |
| **Status** | 🟰 Risk Accepted (2026-10-23: `utm_id` is used for Matomo attribution) |

**Description**
`?utm_id=` (the FCCID) ends up in browser history, server access logs and the analytics on the ACI page that contains the form, and is passed on to the I&E form URL. Because of VULN-001, anyone who reads those logs can opt the customer out. The `Referrer-Policy: strict-origin` header already stops it leaking to third-party sites through referrers.

**Mitigation**
Signed, expiring links (VULN-001) would make a leaked ID harmless after it expires.

**Risk acceptance (2026-10-23)**
The FCCID is carried as `utm_id` on purpose, so that Matomo can attribute visits to it, and Matomo stores it as the campaign ID. The business accepts the risk on the grounds that FCCIDs are random UUIDs, which can't realistically be guessed. The remaining exposure is people who can read Matomo reports or server logs, so access to those should be limited to staff who need it. This reasoning holds only while FCCIDs are random (v4) UUIDs, not time-based (v1) ones.

---

### 🔵 [VULN-011] Upstream success judged only by HTTP status

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Insecure Design (A04) |
| **File(s)** | `public/api/opt-out.php:272-278` |
| **CWE** | CWE-754 (Improper Check for Unusual or Exceptional Conditions) |
| **Status** | ✅ Resolved: no change needed |

**Description**
Any 2xx response from the OptOut API is reported to the customer as "You've opted out". If the API returns 200 with a failure in the body, or 200 for an unknown account, the customer is told their payment won't change when it may still change.

**Mitigation**
Confirmed on 2026-10-22 that the API's response format is fixed and that it signals failure with non-2xx status codes, so the existing status check is correct. Revisit this if the API's contract changes.

---

### 🔵 [VULN-012] API key handled in plaintext outside the intended config file

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **Category** | Secrets in Code (A02) |
| **File(s)** | `optout-config.example.php:9`, `optout-config.php` |
| **CWE** | CWE-798 (Use of Hard-coded Credentials) |
| **Status** | ⚠️ Partially Mitigated (key rotation scheduled) |

**Description**
During setup, the real `x-functions-key` was placed in `optout-config.example.php`. That file isn't git-ignored and is meant to be committed. It was moved to the git-ignored `optout-config.php` before any commit, and the git history (both commits) and the `dist/` folder contain no key. The key has, however, been in an unprotected file and in this working session's transcript.

**Before**
```php
'api_key' => '<real key>',   // in optout-config.example.php
```

**After**
```php
'api_key' => '',             // optout-config.example.php; the real key lives only in git-ignored optout-config.php
```

**Mitigation**
The example file is blank again and `.gitignore` covers `optout-config.php`. As a precaution, rotate the function key on the dev API, and use a separate production key that is only ever entered on the production server.

---

### ⚪ [VULN-013] Google Fonts stylesheet loaded without Subresource Integrity

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **Category** | Software & Data Integrity (A08) |
| **File(s)** | `public/index.html:11` |
| **CWE** | CWE-353 (Missing Support for Integrity Check) |
| **Status** | ❌ Requires Manual Action (optional) |

**Description**
SRI isn't possible here, because Google Fonts serves a different stylesheet depending on the browser. The CSP limits the risk to fonts and styles from Google's domains.

**Mitigation**
Optionally self-host the Nunito and Space Grotesk font files, then remove the Google domains from the CSP.

---

### ⚪ [VULN-014] Documented minimum PHP version is end-of-life

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **Category** | Vulnerable Components (A06) |
| **File(s)** | `README.md` (Deploy section) |
| **CWE** | CWE-1104 (Use of Unmaintained Third Party Components) |
| **Status** | ✅ Fixed (documentation) |

**Description**
The README said "PHP 7.4+". PHP 7.4 and 8.0 no longer get security fixes.

**Mitigation**
The README now recommends PHP 8.1 or later. The code still runs on 7.4.

---

### ⚪ [VULN-015] Stale old build in `dist/`

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **Category** | Security Misconfiguration (A05) |
| **File(s)** | `dist/` (untracked, git-ignored) |
| **CWE** | CWE-1164 (Irrelevant Code) |
| **Status** | ✅ Fixed (`dist/` deleted 2026-10-22) |

**Description**
`dist/` holds the original standalone demo build. It contains no secrets, but uploading it by mistake would publish an out-of-date page.

**Mitigation**
Delete `dist/` locally, and upload only `public/`.

---

## Checked and not vulnerable

| Area | Result |
|---|---|
| Injection (SQL, shell, eval, include) | None. No database, shell or dynamic include; the config path comes from the server environment only |
| XSS | None. User input never reaches `innerHTML`; the DOM is only changed via `textContent`, `hidden` and `href` set from a fixed URL |
| Open redirect | None. The redirect target is the fixed `IE_FORM_URL`; FCCID is added with `searchParams.set` (encoded) |
| SSRF | None. The upstream URL comes from config, must be `https://`, and redirects aren't followed |
| CSRF | Mitigated. `Origin` must equal this site or an exact allowlist entry; JSON content-type is required |
| CORS | Exact-match allowlist, no wildcard, `Vary: Origin` sent |
| Header injection | Key checked for CR/LF; only allowlisted origins are echoed back |
| TLS to upstream | `CURLOPT_SSL_VERIFYPEER`/`VERIFYHOST` enforced |
| Logging | Upstream bodies, FCCIDs and the key are never logged |
| Payload limits | Body capped at 2 KB; reason checked against an allowlist; FCCID must be a UUID (fixed-length regex, no backtracking risk) |

## Dependency Vulnerabilities

| Component | Version | Status |
|---|---|---|
| npm / composer packages | none | No third-party packages are used |
| PHP runtime | 7.4+ supported | Use 8.1+ (see VULN-014). Local dev is 8.5.12 |
| Google Fonts (CDN) | n/a | See VULN-013 |

## Security Headers Audit

| Header | Page (`.htaccess`) | API (`opt-out.php`) |
|---|---|---|
| Content-Security-Policy | ✅ Added | ✅ `default-src 'none'; frame-ancestors 'none'` |
| X-Content-Type-Options | ✅ | ✅ |
| Referrer-Policy | ✅ `strict-origin` (also a meta tag) | n/a |
| Permissions-Policy | ✅ Added | n/a |
| X-Robots-Tag | ✅ | n/a |
| Cache-Control | n/a | ✅ `no-store` |
| Strict-Transport-Security | ✅ Enabled site-wide by the host (VULN-009) | ✅ Same |
| frame-ancestors / X-Frame-Options | ✅ `'none'` (VULN-008) | ✅ `'none'` |

`.htaccess` only applies on Apache with `mod_headers`. On nginx, copy these headers into the server block.

## Recommendations

1. **Compensating controls for the accepted risk (VULN-001):** opt-out volume monitoring, and limited access to Matomo, which records FCCIDs (VULN-010). UUID-only validation is done.
2. **Set `trusted_proxies`** if the production site is behind Cloudflare, Sucuri or a host load balancer (VULN-002).
3. **Rotate the dev function key** and use a separate production key (VULN-012).
4. **Before go-live:** point `api_url` at production, and keep `optout-config.php` outside the web root (or use `OPTOUT_CONFIG`).
5. **Test on the real host** to confirm the headers are sent, `Options -Indexes` is allowed in `.htaccess`, and the temp directory is writable (otherwise the rate limiter quietly turns itself off and logs a warning).

## References

- [OWASP Top 10 (2021)](https://owasp.org/www-project-top-ten/)
- [CWE listings](https://cwe.mitre.org/)
- [OWASP HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html)
- [PHP supported versions](https://www.php.net/supported-versions.php)
