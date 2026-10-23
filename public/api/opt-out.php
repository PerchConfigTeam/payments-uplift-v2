<?php
/**
 * POST api/opt-out.php
 *
 * Server-side proxy to the OptOut API. The browser sends { FCCID, Reason } here;
 * this checks the request, adds the x-functions-key (never sent to the browser)
 * and forwards it.
 *
 * Settings come from environment variables, or from optout-config.php one level
 * above the web root (see optout-config.example.php):
 *   OPTOUT_API_URL  OptOut API URL (must be https)
 *   OPTOUT_API_KEY  x-functions-key
 */
declare(strict_types=1);

// Never print PHP warnings or paths to the browser; they still go to the error log.
ini_set('display_errors', '0');

// Must match the <option> values in index.html.
const ALLOWED_REASONS = ['cantAffordShortTerm', 'cantAffordMediumTerm', 'uncertain'];
// FCCIDs are always UUIDs (any version, either case).
const FCCID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
const MAX_BODY_BYTES = 2048;
const UPSTREAM_TIMEOUT_S = 10;

function respond(int $status, array $body, array $headers = []): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
    foreach ($headers as $header) {
        header($header);
    }
    if ($status !== 204) {
        echo json_encode($body);
    }
    exit;
}

function load_config(): array
{
    $file = getenv('OPTOUT_CONFIG') ?: dirname(__DIR__, 2) . '/optout-config.php';
    $config = is_file($file) ? require $file : [];
    if (!is_array($config)) {
        $config = [];
    }
    return [
        'api_url' => getenv('OPTOUT_API_URL') ?: (string) ($config['api_url'] ?? ''),
        'api_key' => getenv('OPTOUT_API_KEY') ?: (string) ($config['api_key'] ?? ''),
        // Other origins allowed to call this script (CORS). This site's own origin is always allowed.
        'allowed_origins' => (array) ($config['allowed_origins'] ?? []),
        'rate_limit_max' => (int) ($config['rate_limit_max'] ?? 10),
        'rate_limit_window_s' => (int) ($config['rate_limit_window_s'] ?? 600),
        // Proxies/CDNs in front of this server (IPs or CIDR ranges). Forwarded headers are only
        // believed when the request comes directly from one of these.
        'trusted_proxies' => (array) ($config['trusted_proxies'] ?? []),
        // $_SERVER key holding the real client IP when behind a trusted proxy,
        // e.g. 'HTTP_CF_CONNECTING_IP' (Cloudflare) or 'HTTP_X_FORWARDED_FOR'.
        'client_ip_header' => (string) ($config['client_ip_header'] ?? 'HTTP_X_FORWARDED_FOR'),
    ];
}

function ip_in_range(string $ip, string $range): bool
{
    [$subnet, $bits] = array_pad(explode('/', $range, 2), 2, null);
    $ipBin = @inet_pton($ip);
    $subnetBin = @inet_pton((string) $subnet);
    if ($ipBin === false || $subnetBin === false || strlen($ipBin) !== strlen($subnetBin)) {
        return false;
    }
    $maxBits = strlen($ipBin) * 8;
    $bits = $bits === null ? $maxBits : max(0, min($maxBits, (int) $bits));
    $bytes = intdiv($bits, 8);
    if (substr($ipBin, 0, $bytes) !== substr($subnetBin, 0, $bytes)) {
        return false;
    }
    $remainder = $bits % 8;
    if ($remainder === 0) {
        return true;
    }
    $mask = (0xFF << (8 - $remainder)) & 0xFF;
    return (ord($ipBin[$bytes]) & $mask) === (ord($subnetBin[$bytes]) & $mask);
}

function from_trusted_proxy(array $config): bool
{
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    foreach ($config['trusted_proxies'] as $range) {
        if (ip_in_range($remote, (string) $range)) {
            return true;
        }
    }
    return false;
}

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

function is_https(array $config): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    // Behind a trusted load balancer or proxy that terminates TLS.
    return from_trusted_proxy($config)
        && strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

function is_localhost(): bool
{
    // Both the Host header and the connection must be local, so a spoofed Host can't skip the HTTPS check.
    $host = strtolower(preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    return in_array($host, ['localhost', '127.0.0.1', '[::1]'], true)
        && in_array($remote, ['127.0.0.1', '::1'], true);
}

/** Groups IPv6 clients by /64, since one customer connection usually controls a whole /64. */
function rate_limit_key(string $ip): string
{
    $bin = @inet_pton($ip);
    if ($bin !== false && strlen($bin) === 16) {
        return 'v6:' . bin2hex(substr($bin, 0, 8));
    }
    return $ip;
}

/**
 * Records this request against the client's key (IP address) and reports whether it is over the limit.
 * Fails open (returns false) if the temp directory isn't writable.
 */
function rate_limited(string $key, int $max, int $windowSeconds): bool
{
    $dir = sys_get_temp_dir() . '/aci-optout-ratelimit';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        error_log('opt-out: rate limit directory not writable');
        return false;
    }
    // Occasionally delete files for clients not seen this window, so the directory can't grow without limit.
    if (random_int(1, 100) === 1) {
        foreach (glob($dir . '/*') ?: [] as $file) {
            if (@filemtime($file) < time() - $windowSeconds) {
                @unlink($file);
            }
        }
    }
    $fh = @fopen($dir . '/' . hash('sha256', $key), 'c+');
    if ($fh === false) {
        error_log('opt-out: rate limit file not writable');
        return false;
    }
    flock($fh, LOCK_EX);
    $now = time();
    $hits = json_decode(stream_get_contents($fh) ?: '[]', true);
    $hits = array_values(array_filter(is_array($hits) ? $hits : [], function ($t) use ($now, $windowSeconds) {
        return is_int($t) && $t > $now - $windowSeconds;
    }));
    $limited = count($hits) >= $max;
    if (!$limited) {
        $hits[] = $now;
    }
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($hits));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    return $limited;
}

$config = load_config();

// ---- Transport and origin ------------------------------------------------
if (!is_https($config) && !is_localhost()) {
    respond(403, ['ok' => false, 'error' => 'https_required']);
}

$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
$selfOrigin = (is_https($config) ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? '');
$crossOrigin = $origin !== '' && $origin !== $selfOrigin && in_array($origin, $config['allowed_origins'], true);
if ($origin === '' || ($origin !== $selfOrigin && !$crossOrigin)) {
    respond(403, ['ok' => false, 'error' => 'origin_not_allowed']);
}
$corsHeaders = $crossOrigin ? [
    'Access-Control-Allow-Origin: ' . $origin,
    'Access-Control-Allow-Methods: POST',
    'Access-Control-Allow-Headers: Content-Type',
    'Vary: Origin',
] : [];

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method === 'OPTIONS') {
    respond(204, [], $corsHeaders);
}
if ($method !== 'POST') {
    respond(405, ['ok' => false, 'error' => 'method_not_allowed'], array_merge($corsHeaders, ['Allow: POST']));
}

// ---- Configuration -------------------------------------------------------
$apiUrl = $config['api_url'];
$apiKey = $config['api_key'];
if (strpos($apiUrl, 'https://') !== 0 || $apiKey === '' || preg_match('/[\r\n]/', $apiKey)) {
    error_log('opt-out: OPTOUT_API_URL (https) or OPTOUT_API_KEY is not configured');
    respond(500, ['ok' => false, 'error' => 'not_configured'], $corsHeaders);
}

// ---- Rate limit ----------------------------------------------------------
if (rate_limited(rate_limit_key(client_ip($config)), $config['rate_limit_max'], $config['rate_limit_window_s'])) {
    respond(429, ['ok' => false, 'error' => 'rate_limited'],
        array_merge($corsHeaders, ['Retry-After: ' . $config['rate_limit_window_s']]));
}

// ---- Payload -------------------------------------------------------------
if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') !== 0) {
    respond(415, ['ok' => false, 'error' => 'json_required'], $corsHeaders);
}
$raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if (strlen($raw) > MAX_BODY_BYTES) {
    respond(413, ['ok' => false, 'error' => 'payload_too_large'], $corsHeaders);
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    respond(400, ['ok' => false, 'error' => 'invalid_json'], $corsHeaders);
}

$fccid = is_string($body['FCCID'] ?? null) ? trim($body['FCCID']) : '';
$reason = is_string($body['Reason'] ?? null) ? $body['Reason'] : '';
if (!preg_match(FCCID_PATTERN, $fccid)) {
    respond(400, ['ok' => false, 'error' => 'invalid_fccid'], $corsHeaders);
}
if (!in_array($reason, ALLOWED_REASONS, true)) {
    respond(400, ['ok' => false, 'error' => 'invalid_reason'], $corsHeaders);
}

// ---- Forward -------------------------------------------------------------
$ch = curl_init($apiUrl);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode(['FCCID' => $fccid, 'Reason' => $reason]),
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Accept: application/json',
        'x-functions-key: ' . $apiKey,
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => UPSTREAM_TIMEOUT_S,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);
$response = curl_exec($ch);
$curlError = curl_error($ch);
$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($response === false) {
    error_log('opt-out: upstream request failed: ' . $curlError);
    respond(502, ['ok' => false, 'error' => 'upstream_unreachable'], $corsHeaders);
}
if ($status < 200 || $status >= 300) {
    // Status only: the upstream body may contain customer details.
    error_log('opt-out: upstream returned HTTP ' . $status);
    respond(502, ['ok' => false, 'error' => 'upstream_error'], $corsHeaders);
}

respond(200, ['ok' => true], $corsHeaders);
