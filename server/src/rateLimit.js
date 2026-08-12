// IP-based rate limiting for the HTTP API.
//
// Two buckets, because the two risks are different:
//
//   credentials — password guessing against /api/auth/login and the
//     self-service password change. Counts FAILED requests only
//     (skipSuccessfulRequests), so an attacker's budget is spent on wrong
//     guesses while normal use never touches the limit. Both endpoints share
//     one bucket: they are the same attack surface, and /api/auth/password
//     also takes a current password to guess at.
//
//   api — a coarse ceiling on everything else, so a runaway client (or a
//     scraper) cannot pin the LLM job queue or the database. Generous enough
//     that ordinary browsing, imports and exports stay well underneath.
//
// Both key on the client address, which is only correct because createApp
// trusts nginx's X-Forwarded-For — see the `trust proxy` note in app.js.
import rateLimit from 'express-rate-limit';

export const CREDENTIALS_LIMIT = { windowMs: 15 * 60 * 1000, limit: 10 };
export const API_LIMIT = { windowMs: 60 * 1000, limit: 300 };

function build({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // The API answers JSON everywhere else; a bare text body here would break
    // the client's error handling.
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

const passthrough = (req, res, next) => next();

// options === false disables both limiters (used by the test suite, which
// would otherwise exhaust a shared bucket across unrelated assertions).
// Otherwise { credentials, api } override the defaults field by field.
export function createLimiters(options = {}) {
  if (options === false) return { credentials: passthrough, api: passthrough };
  const { credentials = {}, api = {} } = options || {};
  return {
    credentials: build({
      ...CREDENTIALS_LIMIT,
      skipSuccessfulRequests: true,
      message: 'Too many failed attempts. Try again later.',
      ...credentials,
    }),
    api: build({
      ...API_LIMIT,
      message: 'Too many requests. Slow down and try again shortly.',
      ...api,
    }),
  };
}
