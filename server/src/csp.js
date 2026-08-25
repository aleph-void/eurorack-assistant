// Content-Security-Policy: what a document served from this origin may load,
// and where the browser is told to complain when it refuses something.
//
// CSP is the second line, not the first. Everything user-supplied is escaped
// or sanitized before it reaches the page (DOMPurify on every v-html, the
// sanitizer on stored markdown), and this header is what stands between a
// mistake in any of that and a script running with a signed-in session. It
// says three things worth saying out loud:
//
//   - scripts come from this origin's own files and nowhere else, so an
//     injected <script src="evil"> has nothing to fetch and an injected
//     inline script never runs;
//   - the page may be framed by nobody, so a click on a transparent overlay
//     is never a click on this app;
//   - anything the browser refuses is reported to /api/csp-reports, because
//     a policy nobody can see the effect of is a policy nobody dares tighten.
//
// SET IN ONE PLACE PER LAYER, like the cache policy it sits beside in app.js:
//
//   the CLIENT SHELL — index.html and the built assets — is served by nginx,
//     which never reaches this file. Its policy lives in nginx/csp.conf, and
//     it is the interesting one: it governs the pages a person looks at.
//     tests/csp.test.js reads that file and holds it to the invariants below,
//     so the two layers cannot drift apart unnoticed.
//
//   the API — every /api response — is served by Express, and gets the
//     policy of a resource that is not a page at all (API_POLICY). It costs
//     nothing and it is not theatre: /api/manuals streams a user-supplied PDF
//     and /api/panels a picture a manufacturer published, and a browser that
//     is talked into treating one of those as a document must find that it
//     can load nothing and run nothing.
//
// The one exception to "nothing" is a stored file's own styling: the logical
// panels this app draws are SVG with a <style> block in them, so the routes
// that stream bytes use STORED_FILE_POLICY instead.

// Where the browser posts what it refused. The route that receives them is
// routes/cspReports.js; nginx/csp.conf names this same path in report-uri.
export const CSP_REPORT_PATH = '/api/csp-reports';

// Nothing at all: no scripts, no styles, no images, no fetches, no framing,
// no form target, no <base> to re-point relative URLs with. Every /api
// response is JSON or a stream of bytes, so there is nothing here to give up.
export const API_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// The same, plus the inline styling a stored file carries with it: a drawn
// panel is an SVG with a <style> block (services/panelSvg.js), and a PDF
// viewer rendering a manual inline styles its own furniture. Used by the
// routes that stream content-addressed bytes — panels, manuals, captures —
// which override API_POLICY on their way out.
//
// No report-uri on purpose: these bytes are a manufacturer's picture and a
// user's upload, and what a hostile SVG tries to load is a fact about that
// file rather than about this deployment. The reports worth reading are the
// ones from the app's own pages.
export const STORED_FILE_POLICY = `${API_POLICY}; style-src 'unsafe-inline'`;

// Express middleware. Mounted once on /api in app.js, before the routers, so
// no handler can forget it — and before the routes that stream bytes, which
// set their own header over the top of it.
export function cspHeaders({ policy = API_POLICY } = {}) {
  return (req, res, next) => {
    res.set('Content-Security-Policy', policy);
    next();
  };
}
