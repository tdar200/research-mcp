import dns from 'node:dns/promises';
import net from 'node:net';

// Build the blocklist once at module load (cheap, immutable).
function buildBlockList() {
  const bl = new net.BlockList();
  // IPv4 reserved / private / special-use
  bl.addSubnet('0.0.0.0', 8, 'ipv4');        // "this" network
  bl.addSubnet('10.0.0.0', 8, 'ipv4');       // private
  bl.addSubnet('100.64.0.0', 10, 'ipv4');    // CGNAT
  bl.addSubnet('127.0.0.0', 8, 'ipv4');      // loopback
  bl.addSubnet('169.254.0.0', 16, 'ipv4');   // link-local (incl. 169.254.169.254 cloud metadata)
  bl.addSubnet('172.16.0.0', 12, 'ipv4');    // private
  bl.addSubnet('192.0.0.0', 24, 'ipv4');     // IETF protocol assignments
  bl.addSubnet('192.0.2.0', 24, 'ipv4');     // TEST-NET-1
  bl.addSubnet('192.168.0.0', 16, 'ipv4');   // private
  bl.addSubnet('198.18.0.0', 15, 'ipv4');    // benchmarking
  bl.addSubnet('198.51.100.0', 24, 'ipv4');  // TEST-NET-2
  bl.addSubnet('203.0.113.0', 24, 'ipv4');   // TEST-NET-3
  bl.addSubnet('224.0.0.0', 4, 'ipv4');      // multicast
  bl.addSubnet('240.0.0.0', 4, 'ipv4');      // reserved
  // IPv6
  bl.addAddress('::', 'ipv6');               // unspecified
  bl.addAddress('::1', 'ipv6');              // loopback
  bl.addSubnet('fc00::', 7, 'ipv6');         // unique-local
  bl.addSubnet('fe80::', 10, 'ipv6');        // link-local
  bl.addSubnet('ff00::', 8, 'ipv6');         // multicast
  return bl;
}
const BLOCK_LIST = buildBlockList();

export class SsrfError extends Error {
  constructor(message) { super(message); this.name = 'SsrfError'; this.ssrf = true; }
}

/** True when the escape hatch is set. Read at call time so tests can toggle env. */
export function privateAllowed(env = process.env) {
  return env.RESEARCH_MCP_ALLOW_PRIVATE === '1';
}

/**
 * Normalize an IP literal so IPv4-mapped IPv6 (::ffff:127.0.0.1) is checked as v4.
 * Returns { ip, family } or null if not an IP literal.
 */
export function classifyIp(host) {
  // strip brackets from [::1]
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const fam = net.isIP(h);
  if (fam === 0) return null;
  // IPv4-mapped: ::ffff:a.b.c.d  -> treat embedded v4 against v4 list
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && net.isIP(mapped[1]) === 4) return { ip: mapped[1], family: 4 };
  return { ip: h, family: fam };
}

/** Throw SsrfError if a concrete IP is in a blocked range. */
export function assertIpAllowed(ip, family) {
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (BLOCK_LIST.check(ip, type)) {
    throw new SsrfError(`blocked address ${ip} (private/loopback/link-local/reserved range)`);
  }
}

/** Reject non-http(s) schemes and malformed URLs up front. */
export function parseHttpUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new SsrfError(`malformed URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError(`blocked scheme ${u.protocol} (only http/https allowed)`);
  }
  return u;
}

/** Default resolver: dns.lookup all addresses, verbatim:false => respects ipv4first ordering. */
async function defaultResolver(hostname) {
  const recs = await dns.lookup(hostname, { all: true, verbatim: false });
  return recs.map(r => r.address);
}

/**
 * Validate a single URL string is safe to fetch.
 * @param {string} url
 * @param {object} [opts]
 * @param {function} [opts.resolver] - async (hostname) => string[] of IPs. Inject for tests.
 *        Default uses dns.lookup with { all:true, verbatim:false } to honor ipv4first.
 * @param {object} [opts.env=process.env]
 * @returns {Promise<{ host:string, addresses:string[] }>} resolved info (for optional --resolve pinning)
 * @throws {SsrfError}
 */
export async function assertUrlAllowed(url, opts = {}) {
  const { resolver = defaultResolver, env = process.env } = opts;
  if (privateAllowed(env)) {
    // Escape hatch: skip all checks but still reject obviously-broken/non-http schemes.
    const u = parseHttpUrl(url); // throws on non-http(s)
    return { host: u.hostname, addresses: [] };
  }
  const u = parseHttpUrl(url);
  const host = u.hostname;
  // 1) If host is an IP literal, check it directly (no DNS).
  const lit = classifyIp(host);
  if (lit) {
    assertIpAllowed(lit.ip, lit.family);
    return { host, addresses: [lit.ip] };
  }
  // 2) DNS name: resolve and check EVERY returned address (DNS-rebinding-resistant).
  let addresses;
  try {
    addresses = await resolver(host);
  } catch (e) {
    throw new SsrfError(`DNS resolution failed for ${host}: ${e.message}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new SsrfError(`DNS resolution returned no addresses for ${host}`);
  }
  for (const ip of addresses) {
    const c = classifyIp(ip) || { ip, family: net.isIP(ip) };
    assertIpAllowed(c.ip, c.family);
  }
  return { host, addresses };
}

/**
 * Build a curl --resolve pin {host, port, ip} from a URL + its validated
 * addresses, so curl connects to the exact IP we validated (no independent
 * re-resolution). Returns null when there's nothing to pin (e.g. escape hatch).
 */
export function pinFor(url, addresses) {
  if (!addresses || addresses.length === 0) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return { host: u.hostname, port, ip: addresses[0] };
}

/**
 * Wrap an HTTP impl so the fetch cascade enforces SSRF safety, including across
 * redirects AND closing the DNS-rebinding TOCTOU: the IP validated by
 * assertUrlAllowed is pinned into the underlying fetch (curl --resolve) so curl
 * connects to the validated address instead of re-resolving the hostname.
 *
 * @param {function} baseFetch - the underlying curl impl (guardedCurlFetch from http.js)
 * @param {object} [opts] - { resolver, env } forwarded to assertUrlAllowed
 * @returns {function} fetchImpl with the same (url, opts) signature
 */
export function makeGuardedFetch(baseFetch, guardOpts = {}) {
  return async function guardedFetch(url, callOpts = {}) {
    const { addresses } = await assertUrlAllowed(url, guardOpts);
    return baseFetch(url, {
      ...callOpts,
      ssrfPin: pinFor(url, addresses),
      // Per-hop: validate the redirect target AND return its pin so guardedCurlFetch
      // can re-pin curl to the validated IP for the next hop.
      ssrfGuard: async (next) => {
        const r = await assertUrlAllowed(next, guardOpts);
        return pinFor(next, r.addresses);
      },
    });
  };
}
