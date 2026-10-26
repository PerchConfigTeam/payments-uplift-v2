// Shared test helpers: run the PHP proxy under `php -S`, and a local HTTPS stand-in for the OptOut API.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const VALID_FCCID = '3f2b8c1e-7a4d-4e9b-9c2a-1d5e6f7a8b9c';

export function tempDir(prefix = 'optout-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Self-signed certificate for 127.0.0.1/localhost, generated once per name per test run. */
const certCache = {};
export function testCert(name = 'default') {
  if (certCache[name]) return certCache[name];
  const dir = tempDir('optout-cert-');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyFile, '-out', certFile,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  certCache[name] = { dir, keyFile, certFile };
  return certCache[name];
}

/**
 * HTTPS stand-in for the OptOut API. Records every request; reply with `upstream.respond = (req, body, res) => ...`.
 */
export async function startUpstream() {
  const cert = testCert();
  const upstream = {
    requests: [],
    respond: (req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"result":"ok"}');
    },
  };
  const server = https.createServer(
    { key: readFileSync(cert.keyFile), cert: readFileSync(cert.certFile) },
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        upstream.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        upstream.respond(req, body, res);
      });
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream.url = `https://127.0.0.1:${server.address().port}/api/OptOut`;
  upstream.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return upstream;
}

/**
 * Starts `php -S` serving public/ with its own config file and temp dir (so rate-limit state is isolated).
 * `config` is written as optout-config.php; `env` adds environment variables;
 * `caFile` is the CA bundle curl trusts (defaults to the test upstream's certificate).
 */
export async function startProxy({ config = {}, env = {}, caFile = testCert().certFile } = {}) {
  const dir = tempDir();
  const configFile = path.join(dir, 'optout-config.php');
  writeFileSync(configFile, `<?php\nreturn json_decode(${phpString(JSON.stringify(config))}, true);\n`);
  const tmp = path.join(dir, 'tmp');
  const port = await freePort();

  const childEnv = { ...process.env, OPTOUT_CONFIG: configFile, ...env };
  // Don't let a developer's real settings leak into the tests.
  for (const k of ['OPTOUT_API_URL', 'OPTOUT_API_KEY']) if (!(k in env)) delete childEnv[k];

  mkdirSync(tmp);
  const child = spawn('php', [
    // Values are quoted: Windows short paths (C:\USER~1) contain '~', an ini operator.
    '-d', `sys_temp_dir="${tmp}"`,
    // Some builds (e.g. Windows) take curl's CA bundle from openssl.cafile rather than curl.cainfo.
    '-d', `curl.cainfo="${caFile}"`,
    '-d', `openssl.cafile="${caFile}"`,
    '-d', 'log_errors=1',
    '-d', `error_log="${path.join(dir, 'php-error.log')}"`,
    '-S', `127.0.0.1:${port}`, '-t', PUBLIC_DIR,
  ], { env: childEnv, stdio: 'ignore' });

  const proxy = {
    port,
    dir,
    origin: `http://localhost:${port}`,
    errorLog: () => {
      try { return readFileSync(path.join(dir, 'php-error.log'), 'utf8'); } catch { return ''; }
    },
    request: (opts) => request(port, opts),
    stop: async () => {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      rmSync(dir, { recursive: true, force: true });
    },
  };

  // Wait until the server accepts connections.
  for (let i = 0; i < 100; i++) {
    if (await canConnect(port)) return proxy;
    await new Promise((r) => setTimeout(r, 50));
  }
  await proxy.stop();
  throw new Error('php -S did not start');
}

function phpString(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

/**
 * Raw HTTP request to the proxy, with full control over Host/Origin/Content-Type.
 * Defaults to a valid same-origin opt-out POST.
 */
export function request(port, {
  method = 'POST',
  host = `localhost:${port}`,
  origin = `http://localhost:${port}`,
  contentType = 'application/json',
  body = { FCCID: VALID_FCCID, Reason: 'cantAffordShortTerm' },
  headers = {},
} = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const h = { Host: host, ...headers };
  if (origin !== null) h.Origin = origin;
  if (contentType !== null && payload !== '') h['Content-Type'] = contentType;
  if (payload !== '') h['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/opt-out.php', method, headers: h },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
