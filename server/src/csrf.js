// Cross-site request forgery protection.
//
// CSRF is a browser problem: the session cookie rides along automatically on
// any request the browser makes to this origin, including one an attacker's
// page provoked (a hidden form post, a fetch from evil.example). The defense
// here is to refuse state-changing requests the browser itself labels as
// coming from another site, using the two headers a browser always attaches
// and a page can never forge or strip:
//
//   Sec-Fetch-Site — sent by every evergreen browser since ~2020, says
//     outright whether the request crossed an origin boundary.
//   Origin — sent by every browser since ~2011 on cross-origin non-GET
//     requests (and by all of them on CORS requests). It must match the Host
//     the request arrived at.
//
// A request carrying NEITHER header is not a browser (curl, supertest, a
// linked oscilloscope, a script) — those clients attach credentials
// explicitly rather than ambiently, so CSRF does not apply and they pass.
// This is the same design as Go's net/http CrossOriginProtection, and it
// stacks on the SameSite=Lax session cookie (auth.js) rather than replacing
// it: Lax already keeps the cookie off cross-site subresource requests in
// modern browsers, and this check refuses the ones where it would still ride
// (or where an old browser never enforced it) — including cross-site login
// forms, which a token-per-session scheme cannot cover because there is no
// session yet.
//
// Only the Origin's HOST is compared, never its scheme: TLS terminates at
// nginx, so the server cannot tell how the request arrived, and an
// http://host attacking https://host is an active network attacker — a
// problem for HSTS, not CSRF.
//
// Safe methods (GET, HEAD, OPTIONS) pass unchecked; the API keeps its side
// effects behind the other verbs, and the session cookie's SameSite=Lax is
// the line of defense for top-level navigations.
//
// A cross-origin page that may legitimately call the API (there is none
// today) is named in CSRF_TRUSTED_ORIGINS: full origins, comma-separated,
// e.g. "https://companion.example.com". The list is parsed once at startup
// and a malformed entry fails the boot rather than silently protecting
// nothing.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The Origin header is scheme://host[:port] with no path; new URL() both
// validates that and normalizes away a default port, so "https://a.example"
// and "https://a.example:443" compare equal. Returns null for anything that
// does not parse — including the literal "null" an opaque origin (sandboxed
// iframe, data: URL) sends, which deserves no trust.
function originHost(origin) {
  try {
    return new URL(String(origin)).host.toLowerCase();
  } catch {
    return null;
  }
}

export function parseTrustedOrigins(value = process.env.CSRF_TRUSTED_ORIGINS) {
  const trusted = new Set();
  for (const entry of String(value ?? '').split(',')) {
    const origin = entry.trim();
    if (!origin) continue;
    const host = originHost(origin);
    if (!host) throw new Error(`CSRF_TRUSTED_ORIGINS entry is not an origin: ${origin}`);
    trusted.add(host);
  }
  return trusted;
}

// The decision, as a pure function over the request's headers: returns a
// reason string when the request must be refused, null when it may proceed.
export function crossOriginProblem(req, { trustedOrigins } = {}) {
  if (SAFE_METHODS.has(req.method)) return null;

  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  // 'none' is a user-initiated request (address bar, bookmark) — no page
  // provoked it, so there is nothing to forge.
  if (site === 'same-origin' || site === 'none') return null;

  const origin = req.headers.origin;
  const host = origin === undefined ? null : originHost(origin);
  if (host && trustedOrigins?.has(host)) return null;

  // 'same-site' is refused too: a sibling subdomain is another application,
  // and a takeover of one should not carry write access to this one.
  if (site) return `cross-origin request refused (Sec-Fetch-Site: ${site})`;

  // No Sec-Fetch-Site. An older browser still says where a cross-origin
  // request came from via Origin; no Origin at all means no browser.
  if (origin === undefined) return null;
  if (!host) return `cross-origin request refused (Origin: ${origin})`;
  if (host !== String(req.headers.host || '').toLowerCase()) {
    return `cross-origin request refused (Origin: ${origin})`;
  }
  return null;
}

// Express middleware. Mounted once on /api, before the routers, so no
// handler can forget it.
export function csrfProtection({ trustedOrigins = parseTrustedOrigins() } = {}) {
  return (req, res, next) => {
    const problem = crossOriginProblem(req, { trustedOrigins });
    if (problem) return res.status(403).json({ error: problem });
    next();
  };
}

// The WebSocket handshake is a GET, so the middleware's safe-method rule
// would wave it through — but /api/ws authenticates by the session cookie,
// and a page on evil.example can open `new WebSocket('wss://app/api/ws')`
// with that cookie attached (SameSite governs cookies, not who may connect).
// Browsers are required to send Origin on every WebSocket handshake, so here
// the rule is simpler: no Origin is a native client and passes, an Origin
// must be this host or a trusted one.
export function upgradeOriginProblem(req, { trustedOrigins } = {}) {
  // The browser's own same-origin label outranks the Origin/Host comparison,
  // exactly as it does for HTTP above: a dev-server proxy rewrites Host on
  // the way through, but it cannot make a cross-site handshake say
  // 'same-origin'.
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'same-origin' || site === 'none') return null;
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  const host = originHost(origin);
  if (host && trustedOrigins?.has(host)) return null;
  if (!host || host !== String(req.headers.host || '').toLowerCase()) {
    return `cross-origin websocket refused (Origin: ${origin})`;
  }
  return null;
}
