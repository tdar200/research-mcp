import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseCurlOutput, curlFetch, guardedCurlFetch } from '../src/http.js';

const buf = (s) => Buffer.from(s, 'utf8');

// ── parseCurlOutput ──────────────────────────────────────────────────────────

test('parseCurlOutput extracts status, finalUrl, and body', () => {
  const raw = 'hello body\nHTTP_CODE:200\nFINAL_URL:https://example.com/final\n';
  const p = parseCurlOutput(raw, 'https://example.com/req');
  assert.equal(p.status, 200);
  assert.equal(p.finalUrl, 'https://example.com/final');
  assert.equal(p.bodyText, 'hello body');
});

test('parseCurlOutput falls back to HTTP_CODE-only trailer (finalUrl = requested)', () => {
  const raw = 'body\nHTTP_CODE:404\n';
  const p = parseCurlOutput(raw, 'https://example.com/req');
  assert.equal(p.status, 404);
  assert.equal(p.finalUrl, 'https://example.com/req');
  assert.equal(p.bodyText, 'body');
});

// ── curlFetch (still follows redirects, now exposes finalUrl) ─────────────────

test('curlFetch exposes finalUrl and passes --location to curl', async () => {
  let capturedArgs = null;
  const _spawnImpl = mock.fn(async (args) => {
    capturedArgs = args;
    return { code: 0, stdout: buf('ok\nHTTP_CODE:200\nFINAL_URL:https://example.com/landed\n'), stderr: '' };
  });
  const res = await curlFetch('https://example.com/start', { _spawnImpl });
  assert.equal(res.status, 200);
  assert.equal(res.finalUrl, 'https://example.com/landed');
  assert.equal(await res.text(), 'ok');
  assert.ok(capturedArgs.includes('--location'));
});

// ── guardedCurlFetch (manual redirects, per-hop SSRF re-check) ────────────────

test('guardedCurlFetch does NOT pass --location to curl', async () => {
  let capturedArgs = null;
  const _spawnImpl = mock.fn(async (args) => {
    capturedArgs = args;
    return { code: 0, stdout: buf('ok\nHTTP_CODE:200\nREDIRECT_URL:\n'), stderr: '' };
  });
  await guardedCurlFetch('https://example.com/x', { _spawnImpl });
  assert.ok(!capturedArgs.includes('--location'));
});

test('guardedCurlFetch re-checks ssrfGuard on a redirect hop and aborts on a blocked target', async () => {
  const _spawnImpl = mock.fn(async () => ({ code: 0, stdout: buf('\nHTTP_CODE:302\nREDIRECT_URL:http://10.0.0.1/internal\n'), stderr: '' }));
  const ssrfGuard = mock.fn(async (next) => {
    if (next.includes('10.0.0.1')) throw Object.assign(new Error('blocked address'), { ssrf: true });
  });
  await assert.rejects(
    guardedCurlFetch('https://example.com/x', { _spawnImpl, ssrfGuard }),
    /blocked/,
  );
  assert.equal(ssrfGuard.mock.calls.length, 1);
});

test('guardedCurlFetch follows a safe redirect and returns the final 200 body', async () => {
  let n = 0;
  const _spawnImpl = mock.fn(async () => {
    n++;
    return n === 1
      ? { code: 0, stdout: buf('\nHTTP_CODE:302\nREDIRECT_URL:https://example.org/final\n'), stderr: '' }
      : { code: 0, stdout: buf('final body\nHTTP_CODE:200\nREDIRECT_URL:\n'), stderr: '' };
  });
  const ssrfGuard = mock.fn(async () => {});
  const res = await guardedCurlFetch('https://example.com/x', { _spawnImpl, ssrfGuard });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'final body');
  assert.equal(res.finalUrl, 'https://example.org/final');
  assert.equal(ssrfGuard.mock.calls.length, 1);
});

test('guardedCurlFetch enforces a redirect budget', async () => {
  // Always redirects to a new safe URL -> must error after maxRedirs hops.
  let i = 0;
  const _spawnImpl = mock.fn(async () => ({ code: 0, stdout: buf(`\nHTTP_CODE:302\nREDIRECT_URL:https://example.org/${i++}\n`), stderr: '' }));
  await assert.rejects(
    guardedCurlFetch('https://example.com/x', { _spawnImpl, ssrfGuard: async () => {}, maxRedirs: 3 }),
    /too many redirects/,
  );
});
