# eurorack-web

Multi-user web app for managing Eurorack systems: import racks, auto-find and
analyze module manuals with an LLM, build patches with traced signal flow, ask
questions, link a hardware oscilloscope. Vue 3 + Pinia client, Express (ESM)
API, PostgreSQL, dockerized (compose: db / server / nginx).

## Layout

- `server/src/routes/` — one file per API area. The two big areas are split
  into sub-routers composed by an `index.js`:
  - `routes/modules/` — core, detail, components, signals (normalizations /
    routes / switches / pairs), expanders, panel, manuals + shared `helpers.js`
  - `routes/patches/` — core, io (import/export), instances, groups, links,
    cables, settings + shared `helpers.js` (incl. the cable-legality rules)
- `server/src/services/` — domain logic, one concern per file. Serializer
  shapes for module hardware facts live in `services/moduleJson.js`; patch
  ones in `services/patchDetail.js`.
- `server/src/jobs/` — `worker.js` is the queue ENGINE (claiming, leases,
  retries, quota/budget pauses); `handlers.js` holds the per-job-type logic;
  `enqueue.js` the queueing helpers. All are re-exported from `worker.js`.
- `client/src/views/` — one view per route. The two big detail pages are
  split into section components: `client/src/components/moduledetail/` and
  `client/src/components/patchdetail/`, each with a `use*Facts.js` composable
  for the shared derived state. Sections take `:module`/`:patch` + id props
  and emit `reload`.
- `client/tests/views/` — one test file per view.
- Schema: SQL-file migrations in `server/migrations/` are the source of truth
  (never `sequelize.sync()`); models in `server/src/db/models.js`.

## Conventions (enforced patterns — keep them)

- Route handlers are wrapped in `asyncHandler(...)` (routes/asyncHandler.js);
  no per-handler try/catch. A handler that must inspect the error keeps its
  own try/catch (see routes/config.js PUT).
- Ownership is middleware, not inline checks: `requireOwnedModule(db)` /
  `requireOwnedPatch(db)` load the record onto `req.module` / `req.patch` and
  404 otherwise. Every `/:id` route that operates on an owned record takes the
  middleware; GET /api/patches/:id is the deliberate exception (shared patches
  are readable via `readableResource`).
- Response shapes go through the serializer modules, never inline object
  literals, so the same entity serializes identically on every endpoint.
- No prettier config on purpose — running prettier rewrites to double quotes
  against the house style. Format by hand. `npm run lint` (ESLint flat config)
  must stay clean in both `server/` and `client/`.
- `jsconfig.json` has `checkJs: false`; opt files into type checking with a
  leading `// @ts-check` comment.

## Commands

- Server tests: `cd server && npx vitest run` (Vitest + Supertest + pg-mem)
- Client tests: `cd client && npx vitest run` (Vitest + Vue Test Utils + jsdom)
- Lint: `npm run lint` in `server/` and `client/`
- Dev DB migrations: `cd server && npm run migrate`

## Test gotchas (learned the hard way)

- pg-mem stands in for PostgreSQL in server tests. It auto-commits every
  statement (ROLLBACK is a silent no-op — atomicity cannot be asserted), has
  no text search (tests/helpers.js shims to_tsvector & friends), and SILENTLY
  DROPS ROWS when an `OR` predicate is ANDed with anything else — that is why
  several queries fetch flat pages and filter in JS instead of using `Op.or`,
  and why visibility SQL is written as `COALESCE(d.user_id, $2) = $2`.
- Avoid `INSERT ... SELECT WHERE NOT EXISTS`, correlated `EXISTS`, functional
  indexes, jsonb params, and parenthesized belongsToMany joins (use
  through-model hasMany→belongsTo include chains) — pg-mem chokes on all.
- Client tests need jsdom, not happy-dom (DOMPurify breaks under happy-dom).
- LLM backends (`services/llm.js`) shell out to `claude -p` / `codex exec`
  CLIs; tests inject a fake `run`. Worker tests stub `renderImpl` so headless
  chrome never launches.
- The server Docker image must keep `poppler-utils` (pdftotext), `chromium`
  (product-page rendering), `ffmpeg` (video frame sampling) and `yt-dlp`
  (YouTube downloads) installed.

## Big-picture flow

Everything slow is a DB-backed job (`jobs` table): import → find_manual (per
module) → analyze_manual → panel_image; extract_manual runs alongside;
questions run scope_question → user review → answer_question; attached
YouTube videos run download_video (yt-dlp + ffmpeg frames/transcript, no
LLM) → analyze_video (techniques summary onto `module_videos`, then the
work files are deleted); a rack-scoped channel scan (`services/youtube.js`,
YouTube Data API key in app_config `youtube_api_key`) matches a channel's
uploads to the rack's module names and imports the picked ones through that
same per-video pipeline. Progress
streams over a WebSocket at `/api/ws` (per-user event bus). Every job runs on
the job owner's own LLM account (`user_llm_accounts`); quota exhaustion pauses
that account (or the whole queue for unowned work), budgets make queued work
wait rather than fail. Patch tables snapshot module names with SOFT integer
refs (no FK) so patches keep rendering after modules move, re-analyze, or
disappear; live rows are joined opportunistically at read time.
