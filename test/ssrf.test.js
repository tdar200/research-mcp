import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  SsrfError,
  privateAllowed,
  classifyIp,
  assertIpAllowed,
  parseHttpUrl,
  assertUrlAllowed,
  makeGuardedFetch,
} from '../src/ssrf.js';

// A resolver that fails the test if it is ever invoked (proves IP-literal short-circuit).
function throwIfCalled() {
  return mock.fn(async () => {
    throw new Error('resolver should not have been called');
  });
}

test('assertUrlAllowed rejects non-http(s) schemes (file:, ftp:, gopher:)', async () => {
  const resolver = throwIfCalled();
  for (const url of ['file:///etc/passwd', 'ftp://x', 'gopher://x']) {
    await assert.rejects(
      () => assertUrlAllowed(url, { resolver, env: {} }),
      (err) => {
        assert.ok(err instanceof SsrfError);
        assert.match(err.message, /scheme/);
        return true;
      },
      `expected ${url} to be rejected for scheme`,
    );
  }
  assert.equal(resolver.mock.callCount(), 0);
});

test('assertUrlAllowed blocks literal loopback IPv4 127.0.0.1 without DNS', async () => {
  const resolver = throwIfCalled();
  await assert.rejects(
    () => assertUrlAllowed('http://127.0.0.1:8888/healthz', { resolver, env: {} }),
    (err) => {
      assert.ok(err instanceof SsrfError);
      return true;
    },
  );
  // Proves the IP-literal short-circuit: resolver was never invoked.
  assert.equal(resolver.mock.callCount(), 0);
});

test('assertUrlAllowed blocks cloud metadata 169.254.169.254', async () => {
  await assert.rejects(
    () => assertUrlAllowed('http://169.254.169.254/latest/meta-data/', { env: {} }),
    (err) => {
      assert.ok(err instanceof SsrfError);
      assert.match(err.message, /169\.254\.169\.254/);
      return true;
    },
  );
});

test('assertUrlAllowed blocks each private range (10/8, 172.16/12, 192.168/16, 100.64/10)', async () => {
  const urls = [
    'http://10.1.2.3',
    'http://172.16.5.5',
    'http://192.168.0.1',
    'http://100.64.0.1',
  ];
  for (const url of urls) {
    await assert.rejects(
      () => assertUrlAllowed(url, { env: {} }),
      (err) => {
        assert.ok(err instanceof SsrfError, `${url} should throw SsrfError`);
        return true;
      },
      `expected ${url} to be blocked`,
    );
  }
});

test('assertUrlAllowed blocks IPv6 loopback ::1 and link-local fe80:: and unique-local fc00::', async () => {
  const urls = ['http://[::1]/', 'http://[fe80::1]/', 'http://[fc00::1]/'];
  for (const url of urls) {
    await assert.rejects(
      () => assertUrlAllowed(url, { env: {} }),
      (err) => {
        assert.ok(err instanceof SsrfError, `${url} should throw SsrfError`);
        return true;
      },
      `expected ${url} to be blocked`,
    );
  }
});

test('assertUrlAllowed blocks IPv4-mapped IPv6 ::ffff:127.0.0.1', async () => {
  await assert.rejects(
    () => assertUrlAllowed('http://[::ffff:127.0.0.1]/', { env: {} }),
    (err) => {
      assert.ok(err instanceof SsrfError);
      return true;
    },
  );
  // Direct unit check that classifyIp normalizes the mapped form to v4.
  const c = classifyIp('[::ffff:127.0.0.1]');
  assert.deepEqual(c, { ip: '127.0.0.1', family: 4 });
});

test('assertUrlAllowed blocks a public hostname that DNS-resolves to a private IP', async () => {
  const resolver = mock.fn(async (host) => {
    assert.equal(host, 'evil.example.com');
    return ['10.0.0.5'];
  });
  await assert.rejects(
    () => assertUrlAllowed('http://evil.example.com/', { resolver, env: {} }),
    (err) => {
      assert.ok(err instanceof SsrfError);
      return true;
    },
  );
  assert.equal(resolver.mock.callCount(), 1);
});

test('assertUrlAllowed blocks when ANY of multiple resolved addresses is private', async () => {
  const resolver = mock.fn(async () => ['8.8.8.8', '127.0.0.1']);
  await assert.rejects(
    () => assertUrlAllowed('http://mixed.example.com/', { resolver, env: {} }),
    (err) => {
      assert.ok(err instanceof SsrfError);
      return true;
    },
  );
});

test('assertUrlAllowed allows a public hostname resolving to a public IP', async () => {
  const resolver = mock.fn(async () => ['93.184.216.34']);
  const result = await assertUrlAllowed('http://example.com/', { resolver, env: {} });
  assert.equal(result.host, 'example.com');
  assert.deepEqual(result.addresses, ['93.184.216.34']);
});

test('assertUrlAllowed surfaces DNS failure as SsrfError not raw throw', async () => {
  const resolver = mock.fn(async () => { throw new Error('ENOTFOUND'); });
  await assert.rejects(
    () => assertUrlAllowed('http://nope.example.com/', { resolver, env: {} }),
    (err) => {
      assert.ok(err instanceof SsrfError);
      assert.match(err.message, /DNS resolution failed/);
      return true;
    },
  );
});

test('RESEARCH_MCP_ALLOW_PRIVATE=1 bypasses IP checks but still rejects bad schemes', async () => {
  const env = { RESEARCH_MCP_ALLOW_PRIVATE: '1' };
  // private IP now allowed
  const ok = await assertUrlAllowed('http://127.0.0.1', { env });
  assert.equal(ok.host, '127.0.0.1');
  assert.equal(privateAllowed(env), true);
  // bad scheme still rejected even with escape hatch
  await assert.rejects(
    () => assertUrlAllowed('file://x', { env }),
    (err) => {
      assert.ok(err instanceof SsrfError);
      assert.match(err.message, /scheme/);
      return true;
    },
  );
});

test('makeGuardedFetch calls baseFetch only after assertUrlAllowed passes', async () => {
  // 1) Blocked URL: baseFetch must never be called.
  const baseFetchBlocked = mock.fn(async () => ({ ok: true }));
  const guardedBlocked = makeGuardedFetch(baseFetchBlocked, { env: {} });
  await assert.rejects(
    () => guardedBlocked('http://10.0.0.1', {}),
    (err) => {
      assert.ok(err instanceof SsrfError);
      return true;
    },
  );
  assert.equal(baseFetchBlocked.mock.callCount(), 0);

  // 2) Public URL: baseFetch called once with an ssrfGuard fn in opts.
  const resolver = mock.fn(async () => ['93.184.216.34']);
  const baseFetchOk = mock.fn(async () => ({ ok: true, status: 200 }));
  const guardedOk = makeGuardedFetch(baseFetchOk, { resolver, env: {} });
  await guardedOk('http://example.com/', { headers: { a: '1' } });
  assert.equal(baseFetchOk.mock.callCount(), 1);
  const [calledUrl, calledOpts] = baseFetchOk.mock.calls[0].arguments;
  assert.equal(calledUrl, 'http://example.com/');
  assert.equal(typeof calledOpts.ssrfGuard, 'function');
  // original opts preserved
  assert.deepEqual(calledOpts.headers, { a: '1' });
});

// Extra coverage for the lower-level helpers (still part of the export contract).
test('parseHttpUrl returns URL for http/https and throws SsrfError for malformed', () => {
  assert.equal(parseHttpUrl('https://example.com/x').protocol, 'https:');
  assert.equal(parseHttpUrl('http://example.com/x').protocol, 'http:');
  assert.throws(() => parseHttpUrl('not a url'), (err) => {
    assert.ok(err instanceof SsrfError);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('classifyIp returns null for hostnames and strips brackets for IPv6 literals', () => {
  assert.equal(classifyIp('example.com'), null);
  assert.deepEqual(classifyIp('[::1]'), { ip: '::1', family: 6 });
  assert.deepEqual(classifyIp('8.8.8.8'), { ip: '8.8.8.8', family: 4 });
});

test('assertIpAllowed throws for blocked IP and passes for public IP', () => {
  assert.throws(() => assertIpAllowed('127.0.0.1', 4), (err) => err instanceof SsrfError);
  assert.doesNotThrow(() => assertIpAllowed('93.184.216.34', 4));
});
