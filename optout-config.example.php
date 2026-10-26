<?php
/**
 * Copy to optout-config.php (git-ignored) and fill in the key.
 * Keep this file OUTSIDE the web root: it sits next to public/, not inside it.
 * Environment variables OPTOUT_API_URL and OPTOUT_API_KEY take precedence over these values.
 */
return [
    'api_url' => 'https://droogmediadev.azurewebsites.net/api/OptOut',
    'api_key' => '',

    // Other sites allowed to call api/opt-out.php from the browser, e.g. 'https://www.example.com'.
    // Leave empty if the form and the PHP script are on the same site.
    'allowed_origins' => [],

    // Opt-out attempts allowed per IP address in each window.
    'rate_limit_max' => 30,
    'rate_limit_window_s' => 600,

    // If a CDN or proxy sits in front of the site, list its IPs/ranges here so the rate limit and
    // HTTPS check use the real client details, e.g. Cloudflare's ranges with 'HTTP_CF_CONNECTING_IP'.
    // Leave empty when clients connect directly.
    'trusted_proxies' => [],
    'client_ip_header' => 'HTTP_X_FORWARDED_FOR',
];
