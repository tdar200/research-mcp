import { spawn } from 'node:child_process';

/**
 * Minimal curl-backed HTTP client matching just enough of the fetch Response
 * shape that our callers (search.js, fetch.js) need.
 *
 * Why curl instead of Node's built-in fetch?
 *   In some environments (Cloudflare-fronted hosts + certain network paths),
 *   Node's undici / node:https time out on TCP connect while curl succeeds
 *   on the very same IPs. Rather than chase TLS fingerprinting or kernel TCP
 *   tuning, we shell out. Curl is universally available and stable.
 *
 * Returns: { ok, status, statusText, finalUrl, text() } — fetch-Response-ish.
 * `finalUrl` is curl's effective URL after redirects (curlFetch) or the URL we
 * actually fetched (guardedCurlFetch) — used by the URL-identity check.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

// curlFetch follows redirects itself, so url_effective is the final landed URL.
const CURL_WRITE_OUT = '\nHTTP_CODE:%{http_code}\nFINAL_URL:%{url_effective}\n';
// guardedCurlFetch does NOT follow redirects; redirect_url is the next hop.
const GUARDED_WRITE_OUT = '\nHTTP_CODE:%{http_code}\nREDIRECT_URL:%{redirect_url}\n';

/**
 * Parse curlFetch stdout (HTTP_CODE + FINAL_URL trailer) into structured parts.
 * Exported so the parse logic is unit-testable without spawning curl.
 * @param {string} raw - full curl stdout (body + trailer)
 * @param {string} requestedUrl - fallback when url_effective is empty
 * @returns {{status:number, finalUrl:string, bodyText:string}|null}
 */
export function parseCurlOutput(raw, requestedUrl) {
  let m = raw.match(/\nHTTP_CODE:(\d+)\nFINAL_URL:([^\n]*)\n?$/);
  if (m) {
    return {
      status: Number(m[1]),
      finalUrl: (m[2] || '').trim() || requestedUrl,
      bodyText: raw.slice(0, m.index),
    };
  }
  // Fallback: HTTP_CODE-only trailer (defensive — older/odd curl).
  m = raw.match(/\nHTTP_CODE:(\d+)\n?$/);
  if (m) {
    return { status: Number(m[1]), finalUrl: requestedUrl, bodyText: raw.slice(0, m.index) };
  }
  return null;
}

/** Parse guardedCurlFetch stdout (HTTP_CODE + REDIRECT_URL trailer). */
function parseGuardedOutput(raw) {
  let m = raw.match(/\nHTTP_CODE:(\d+)\nREDIRECT_URL:([^\n]*)\n?$/);
  if (m) {
    return { status: Number(m[1]), redirectUrl: (m[2] || '').trim(), bodyText: raw.slice(0, m.index) };
  }
  m = raw.match(/\nHTTP_CODE:(\d+)\n?$/);
  if (m) {
    return { status: Number(m[1]), redirectUrl: '', bodyText: raw.slice(0, m.index) };
  }
  return null;
}

/**
 * Spawn curl with the given args (target url must already be the last arg).
 * Resolves with { code, stdout(Buffer), stderr } — never rejects on a non-zero
 * exit (callers decide). Rejects only on spawn error.
 */
function spawnCurl(args, body) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (body != null) { child.stdin.write(body); child.stdin.end(); }
    else child.stdin.end();
  });
}

/** Common curl args shared by both fetchers (no redirect flags, no url). */
function commonArgs({ method, headers, body, timeoutMs, maxBytes, writeOut }) {
  const args = [
    '--silent',
    '--show-error',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--max-filesize', String(maxBytes),
    '--http1.1', // avoid HTTP/2 SETTINGS oddities
    '--write-out', writeOut,
    '-X', method,
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('--data-binary', '@-');
  return args;
}

function makeResponse(status, finalUrl, bodyText) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusTextFor(status),
    finalUrl,
    text: async () => bodyText,
  };
}

/**
 * Fetch a URL via curl, following redirects (--location). Unchanged external
 * behavior except the additive `finalUrl` field. Used by ALL internal callers
 * (SearXNG/Crawl4AI/extractors) — must keep following redirects transparently.
 */
export async function curlFetch(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    _spawnImpl = spawnCurl, // injectable for tests
  } = opts;

  const args = [
    ...commonArgs({ method, headers, body, timeoutMs, maxBytes, writeOut: CURL_WRITE_OUT }),
    '--location',
    '--max-redirs', '5',
    url,
  ];

  const { code, stdout, stderr } = await _spawnImpl(args, body);
  if (code !== 0) {
    throw new Error(`curl exited ${code}: ${stderr.trim() || 'unknown error'}`);
  }
  const raw = stdout.toString('utf8');
  const parsed = parseCurlOutput(raw, url);
  if (!parsed) {
    throw new Error(`could not parse HTTP code from curl output`);
  }
  return makeResponse(parsed.status, parsed.finalUrl, parsed.bodyText);
}

/**
 * SSRF-aware fetch: does NOT let curl follow redirects. Manually walks each 3xx
 * hop, re-running `opts.ssrfGuard(nextUrl)` before continuing, so a public URL
 * cannot redirect into a private/loopback range. Returns the first non-3xx
 * response. `finalUrl` on the returned response is the URL actually fetched.
 *
 * @param {object} [opts]
 * @param {function} [opts.ssrfGuard] - async (url) => pin|void; throws to abort a hop,
 *        returns a {host,port,ip} pin to re-pin curl for the next hop
 * @param {object} [opts.ssrfPin] - {host,port,ip} to pin the first hop via curl --resolve
 * @param {number} [opts.maxRedirs=5]
 * @param {function} [opts._spawnImpl=spawnCurl] - inject for tests
 */
export async function guardedCurlFetch(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    ssrfGuard,
    ssrfPin,
    maxRedirs = 5,
    _spawnImpl = spawnCurl,
  } = opts;

  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  let pin = ssrfPin; // {host,port,ip} validated address to pin curl to (rebinding defense)

  for (let hop = 0; ; hop++) {
    const args = [
      ...commonArgs({
        method: currentMethod, headers, body: currentBody,
        timeoutMs, maxBytes, writeOut: GUARDED_WRITE_OUT,
      }),
      // Pin curl to the validated IP so it cannot independently re-resolve the
      // hostname to a private address between our check and curl's connect.
      ...(pin ? ['--resolve', `${pin.host}:${pin.port}:${pin.ip}`] : []),
      currentUrl,
    ];

    const { code, stdout, stderr } = await _spawnImpl(args, currentBody);
    if (code !== 0) {
      throw new Error(`curl exited ${code}: ${stderr.trim() || 'unknown error'}`);
    }
    const raw = stdout.toString('utf8');
    const parsed = parseGuardedOutput(raw);
    if (!parsed) {
      throw new Error(`could not parse HTTP code from curl output`);
    }

    const isRedirect = parsed.status >= 300 && parsed.status < 400 && parsed.redirectUrl;
    if (!isRedirect) {
      return makeResponse(parsed.status, currentUrl, parsed.bodyText);
    }
    if (hop >= maxRedirs) {
      throw new Error(`too many redirects (>${maxRedirs}) starting at ${url}`);
    }

    const nextUrl = new URL(parsed.redirectUrl, currentUrl).href;
    // Re-validate each hop; throws SsrfError to abort. Returns the next hop's
    // validated pin so we connect curl to the checked IP (rebinding defense).
    pin = ssrfGuard ? await ssrfGuard(nextUrl) : null;

    // HTTP method semantics: 307/308 preserve method+body; 301/302/303 -> GET.
    if (parsed.status !== 307 && parsed.status !== 308) {
      currentMethod = 'GET';
      currentBody = null;
    }
    currentUrl = nextUrl;
  }
}

function statusTextFor(code) {
  if (code === 200) return 'OK';
  if (code === 429) return 'Too Many Requests';
  if (code === 404) return 'Not Found';
  if (code === 500) return 'Internal Server Error';
  if (code === 502) return 'Bad Gateway';
  if (code === 503) return 'Service Unavailable';
  return String(code);
}
