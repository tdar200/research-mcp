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
 * Returns: { ok, status, statusText, text() } — fetch-Response-ish.
 */
export function curlFetch(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 15000,
    maxBytes = 5 * 1024 * 1024, // 5 MB safety cap
  } = opts;

  return new Promise((resolve, reject) => {
    const args = [
      '--silent',
      '--show-error',
      '--location',                    // follow redirects
      '--max-redirs', '5',
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '--max-filesize', String(maxBytes),
      '--http1.1',                     // avoid HTTP/2 SETTINGS oddities
      '--write-out', '\nHTTP_CODE:%{http_code}\n',
      '-X', method,
    ];

    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
    if (body != null) {
      args.push('--data-binary', '@-');
    }

    args.push(url);

    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = Buffer.alloc(0);
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`curl exited ${code}: ${stderr.trim() || 'unknown error'}`));
      }
      const raw = stdout.toString('utf8');
      const m = raw.match(/\nHTTP_CODE:(\d+)\n?$/);
      if (!m) {
        return reject(new Error(`could not parse HTTP code from curl output`));
      }
      const status = Number(m[1]);
      const bodyText = raw.slice(0, m.index);

      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: statusTextFor(status),
        text: async () => bodyText,
      });
    });

    if (body != null) {
      child.stdin.write(body);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
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
