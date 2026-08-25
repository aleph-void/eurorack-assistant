// Where a Content-Security-Policy violation lands.
//
// The policy itself is a header (server/src/csp.js for the API, nginx/csp.conf
// for the client shell), and a policy nobody can see the effect of is a policy
// nobody dares tighten: the browser is the only witness to what it refused,
// and it only says so if the header names somewhere to say it. That is what
// this table is — the receiving end of `report-uri`, read by an admin on
// /admin/csp-reports.
//
// ONE ROW PER DISTINCT VIOLATION, NOT PER REPORT. A violation in a render
// loop is a report per frame per viewer, and a table with a row for each of
// them is both a filled disk and an unreadable page. `fingerprint` is the
// hash of the fields that make two reports the same complaint (the directive,
// what was blocked, where, and the line it happened on); a report that
// matches one already here counts up and moves its last_seen_at instead of
// inserting. UNIQUE is what makes that safe under two browsers reporting at
// once — the insert that loses the race is refused and retried as the update
// it should have been.
//
// Nothing here is anybody's private data, and no user_id is recorded: a
// violation is a fact about the deployment, the report arrives from a page
// that may have no session at all (the login screen is the likeliest place a
// policy first bites), and asking who was looking would only make the same
// broken page report itself once per account.

export const description = 'CSP violation reports, one row per distinct violation';

export async function up({ sql }) {
  await sql`
CREATE TABLE csp_reports (
  id SERIAL PRIMARY KEY,
  -- sha256 of the fields below that identify the violation; see
  -- services/cspReports.js, which is the only thing that computes it.
  fingerprint TEXT NOT NULL UNIQUE,
  -- 'enforce' (the resource was blocked) or 'report' (report-only: the
  -- browser let it through and only told us). The one field that says
  -- whether the reader is looking at a break or at a rehearsal.
  disposition TEXT NOT NULL DEFAULT '',
  -- The directive that did the refusing ('script-src-elem', 'img-src', ...).
  directive TEXT NOT NULL DEFAULT '',
  -- What was refused, and the page that asked for it. 'inline', 'eval' and
  -- 'blob' are the browser's own words for a resource with no URL.
  blocked_uri TEXT NOT NULL DEFAULT '',
  document_uri TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  -- Where in our own code it happened, when the browser knows.
  source_file TEXT NOT NULL DEFAULT '',
  line_number INTEGER,
  column_number INTEGER,
  -- The first characters of a blocked inline script/style, when the policy
  -- asked for a sample. The browser sends at most 40 of them.
  script_sample TEXT NOT NULL DEFAULT '',
  -- The whole policy the browser was enforcing, and who was enforcing it:
  -- between a stale cached shell and a browser that ignores a directive,
  -- "which policy did you actually have?" is the first question worth asking.
  original_policy TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  report_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX csp_reports_last_seen_idx ON csp_reports (last_seen_at);
`;
}

export async function down({ dropTable }) {
  await dropTable('csp_reports');
}
