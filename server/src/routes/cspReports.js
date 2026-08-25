// The receiving end of the Content-Security-Policy's report-uri, and the page
// an admin reads it on.
//
// TWO HALVES WITH DIFFERENT DOORS, which is the whole shape of this file:
//
//   POSTING one is unauthenticated, because the reporter is a browser
//     refusing to load something and not a caller with a session. The policy
//     bites hardest exactly where nobody is signed in — the login page is the
//     first thing an unknown visitor is served — and a report that required a
//     session would be the one report never sent. It is a write anyone on the
//     internet can make, so it is the most carefully bounded route in the
//     app: its own rate-limit bucket (rateLimit.js), a body limit far under
//     the API's, at most twenty violations from one delivery, every field
//     truncated, and a ceiling on how many distinct violations the table will
//     ever hold (services/cspReports.js).
//
//   READING them is the admin's alone. A violation report names the URLs a
//     page tried to load and quotes the first characters of whatever was
//     blocked, which is a description of this deployment's insides and, on a
//     bad day, of one user's browsing; it is operational detail about the
//     server, in the same drawer as the queue and the application config.
//     Emptying the table is admin-only for the same reason it exists: after a
//     policy is fixed, the interesting question is what comes back.

import express, { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth, requireAdmin } from '../auth.js';
import { cspReportJson, parseReports, recordViolation } from '../services/cspReports.js';
import { asyncHandler } from './asyncHandler.js';

// One page of the list, paged exactly as the job list is: newest first, by
// id, with `before` carrying the reader back. The rows here are deduped, so
// the list grows with each NEW violation rather than with each report — but
// a policy tightened against a live app can produce hundreds in an afternoon.
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

// A report is a handful of URLs. The API's own 40 MB ceiling is for patch
// documents and panel uploads and has no business on a route with no session
// behind it.
const MAX_BODY = '64kb';

// What a browser labels the POST: application/csp-report for report-uri,
// application/reports+json for the Reporting API. Neither is a type express
// parses on its own, which is what this parser is for; a plain
// application/json body (curl, the tests) has already been read by the app's
// own parser by the time it arrives here.
const REPORT_CONTENT_TYPES = ['application/csp-report', 'application/reports+json'];

export function cspReportRoutes(db) {
  const { CspReport } = db.models;
  const router = Router();

  const parseBody = express.json({ type: REPORT_CONTENT_TYPES, limit: MAX_BODY });
  // A body that is too big or not JSON is answered rather than thrown: the
  // app's error handler would log a stack trace for every one of them, and
  // this is a route strangers can post to.
  const acceptBody = (req, res, next) =>
    parseBody(req, res, (err) => (err ? res.status(400).end() : next()));

  // Nothing is echoed back and nothing is said about what was recorded: the
  // browser is not reading the answer, and an attacker probing the endpoint
  // learns nothing from a 204 it did not already know.
  router.post(
    '/',
    acceptBody,
    asyncHandler(async (req, res) => {
      const violations = parseReports(req.body, { userAgent: req.get('user-agent') || '' });
      for (const violation of violations) await recordViolation(db, violation);
      res.status(204).end();
    })
  );

  router.use(requireAuth(db), requireAdmin());

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE));
      const before = Math.max(0, Number(req.query.before) || 0);
      const where = before ? { id: { [Op.lt]: before } } : {};
      // Of the whole list, not of the page: the footer says which part of
      // what the reader is looking at.
      const total = await CspReport.count();
      // The count of reports behind those rows, which is the number that
      // says whether a violation is a curiosity or the whole app being
      // broken for everybody.
      const reported = (await CspReport.sum('report_count')) || 0;
      // Newest first BY ID — the order a violation was first seen in, not
      // the order it last happened in. A cursor has to point at something
      // that cannot move under the reader, and last_seen_at moves every time
      // the same violation is reported again; each row carries both dates
      // and its own count, so nothing is lost by ordering on the stable one.
      const rows = await CspReport.findAll({
        where,
        order: [['id', 'DESC']],
        limit: limit + 1,
      });
      const has_more = rows.length > limit;
      const page = has_more ? rows.slice(0, limit) : rows;
      res.json({
        total,
        reported,
        limit,
        has_more,
        next_before: has_more ? page[page.length - 1].id : null,
        reports: page.map(cspReportJson),
      });
    })
  );

  // Emptying the table is how a fixed policy is confirmed: clear it, and
  // whatever comes back is still broken.
  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const deleted = await CspReport.destroy({ where: {} });
      res.json({ deleted });
    })
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const deleted = await CspReport.destroy({ where: { id: Number(req.params.id) || 0 } });
      if (!deleted) return res.status(404).json({ error: 'Report not found' });
      res.json({ deleted });
    })
  );

  return router;
}
