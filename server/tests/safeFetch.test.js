// The SSRF guard: what it refuses to point the server at, and that it re-checks
// every redirect hop rather than only the first URL.

import { describe, it, expect } from 'vitest';
import {
  isBlockedAddress,
  assertUrlAllowed,
  safeFetch,
  BlockedUrlError,
} from '../src/services/safeFetch.js';

// A resolver that maps a hostname to whatever address the test wants, so the
// policy can be exercised without touching real DNS.
const resolveTo = (address, family = 4) => async () => [{ address, family }];
const PUBLIC = resolveTo('93.184.216.34');

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local/metadata and CGNAT', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.9.9', '169.254.169.254', '100.64.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it('blocks IPv6 loopback, unique-local and an IPv4-mapped loopback', () => {
    for (const ip of ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it('allows ordinary public addresses', () => {
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:2800:220:1::')).toBe(false);
  });
  it('blocks anything unparseable', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd', { lookupImpl: PUBLIC })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertUrlAllowed('gopher://x/', { lookupImpl: PUBLIC })).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects embedded credentials', async () => {
    await expect(assertUrlAllowed('http://user:pass@example.com/', { lookupImpl: PUBLIC })).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects a literal metadata IP without any DNS', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects a name that resolves into a blocked range', async () => {
    await expect(assertUrlAllowed('http://internal.example/', { lookupImpl: resolveTo('127.0.0.1') })).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects when ANY resolved address is blocked', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(assertUrlAllowed('http://dual.example/', { lookupImpl: mixed })).rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('allows a public host', async () => {
    await expect(assertUrlAllowed('https://example.com/x.png', { lookupImpl: PUBLIC })).resolves.toBeTruthy();
  });
});

describe('safeFetch redirects', () => {
  const okResponse = { status: 200, headers: { get: () => null }, body: null };

  it('re-validates each redirect hop and blocks a redirect to the metadata IP', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.includes('start.example')) {
        return { status: 302, headers: { get: (h) => (h === 'location' ? 'http://169.254.169.254/' : null) }, body: null };
      }
      return okResponse;
    };
    await expect(
      safeFetch('http://start.example/', { fetchImpl, lookupImpl: PUBLIC })
    ).rejects.toBeInstanceOf(BlockedUrlError);
    // It followed the first hop but never issued the request to the metadata IP.
    expect(seen).toEqual(['http://start.example/']);
  });

  it('follows a redirect to another allowed host', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('start.example')) {
        return { status: 301, headers: { get: (h) => (h === 'location' ? 'https://cdn.example/final' : null) }, body: null };
      }
      return { status: 200, headers: { get: () => null }, body: null };
    };
    const res = await safeFetch('http://start.example/', { fetchImpl, lookupImpl: PUBLIC });
    expect(res.status).toBe(200);
  });
});
