// SSRF guard for the two places the server fetches a URL that ultimately came
// from outside it: a panel image the user pasted (routes/modules.js) and the
// manual PDFs / product pages an LLM research step names (services/manualFinder.js).
//
// The danger is not the fetch itself but where it can be pointed: a URL that
// resolves to the loopback interface, the Docker/host private network, or the
// cloud metadata endpoint (169.254.169.254) turns "download this picture" into
// "read that internal service and hand me the bytes back" — and the panel
// route stores the result and serves it back by hash, so the response is
// readable, not just blind.
//
// Address classification is delegated to ipaddr.js (the same library Express's
// proxy-addr uses) rather than hand-written CIDR math: we accept an address
// only when its range() is the globally-routable "unicast" class and reject
// every other class (loopback, private, linkLocal, uniqueLocal, carrier-grade
// NAT, reserved, multicast, ...). Two things still have to be arranged around
// it, because a plain fetch(redirect:'follow') does neither: the host is
// resolved and EVERY resolved address checked, and EVERY redirect hop is
// re-validated (an allowed host can 302 to http://169.254.169.254), so
// redirects are followed by hand.

import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const MAX_REDIRECTS = 5;

// The resolver used when a caller does not pass its own. It is a seam only so
// the test suite can resolve its fake hostnames deterministically without
// touching the network (see tests/helpers.js) — production always runs the
// real dns.lookup. It is never changed at runtime.
let defaultLookup = dns.lookup;
export function setDefaultLookup(fn) {
  defaultLookup = fn || dns.lookup;
}

// Default-deny: the only class we send traffic to is globally-routable
// unicast. ipaddr.js resolves an IPv4-mapped IPv6 address (::ffff:127.0.0.1)
// to its own "ipv4Mapped" class, so unwrap it and judge the embedded v4 —
// otherwise loopback smuggled through a v6 literal would read as non-loopback.
export function isBlockedAddress(ip) {
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // unparseable is not something we send traffic to
  }
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  return addr.range() !== 'unicast';
}

// Resolve every address a host maps to and reject if ANY of them is blocked —
// a name that returns one public and one loopback address must not squeak
// through on a lucky ordering.
async function assertHostAllowed(hostname, lookupImpl) {
  // A literal IP in the URL never touches DNS.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedUrlError(`address ${hostname} is not allowed`);
    }
    return;
  }
  let records;
  try {
    records = await lookupImpl(hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`could not resolve ${hostname}`);
  }
  if (!records.length) throw new BlockedUrlError(`could not resolve ${hostname}`);
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(`${hostname} resolves to a disallowed address`);
    }
  }
}

// Validate a single URL: http(s) only, no embedded credentials, host not in a
// blocked range. Throws BlockedUrlError otherwise. Exported so callers that
// want to reject early (before any network) can reuse exactly this test.
export async function assertUrlAllowed(rawUrl, { lookupImpl = defaultLookup } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('URL is not valid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BlockedUrlError('only http and https URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new BlockedUrlError('URLs may not carry credentials');
  }
  await assertHostAllowed(parsed.hostname, lookupImpl);
  return parsed;
}

// Drop-in fetch that validates the target and every redirect hop against the
// SSRF policy. Callers pass redirect-less options; this owns redirect handling
// (redirect:'manual') so it can re-check each Location. The returned Response
// is the final hop's, already known to point at an allowed host.
export async function safeFetch(
  rawUrl,
  { fetchImpl = fetch, lookupImpl = defaultLookup, headers = {}, method = 'GET', signal } = {}
) {
  let current = await assertUrlAllowed(rawUrl, { lookupImpl });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current.href, {
      method,
      headers,
      redirect: 'manual',
      signal,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current.href);
      await assertUrlAllowed(next.href, { lookupImpl });
      current = next;
      if (typeof res.body?.cancel === 'function') res.body.cancel().catch(() => {});
      continue;
    }
    return res;
  }
  throw new BlockedUrlError('too many redirects');
}
