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
- `routes/systems.js` — systems: collections of racks patched together as
  one instrument. A rack joins/leaves via `PUT /api/racks/:id/system`; the
  system's own routes arrange the racks on a floor plan.
- `server/src/services/` — domain logic, one concern per file. Serializer
  shapes for module hardware facts live in `services/moduleJson.js`; patch
  ones in `services/patchDetail.js`; rack ones in `services/rackJson.js`.
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
- Panel pictures: a panel's markers are stored as fractions of the WHOLE
  image and every renderer maps them through `panel.crop`, so a crop can move
  without rewriting placements. `POST /api/modules/:id/panel/trim` is the one
  thing that cuts the FILE down to the front plate — it re-bases every marker
  onto what survives, resets the crop to full, and sets `module_panels.trimmed`
  so it cannot be pressed a second time and eat into the hardware. Anything
  drawing a panel as a plain `<img>` must offset it with `panelCropStyle()`
  (client/src/panelLayout.js), or a photograph's backdrop is drawn as panel.
- Cache policy is set in one place per layer, never ad hoc in a handler:
  `app.js` stamps every `/api` response `private, no-cache` (`no-store` on
  the credential routes), and the routes that stream content-addressed bytes
  (panels, captures, manuals) override that with `private, max-age=31536000,
  immutable`. The built client's policy lives in `nginx/cache.conf`, which
  BOTH vhosts include — `nginx/nginx.conf` and `nginx/tls.conf.template`.
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
  (YouTube downloads) installed — plus `deno` (yt-dlp's JS challenge solver;
  without it YouTube offers only storyboards) and the bgutil PO-token plugin
  zip, whose version is pinned to the `potprovider` compose sidecar.

## Big-picture flow

Everything slow is a DB-backed job (`jobs` table): import → find_manual (per
module) → analyze_manual → panel_image; extract_manual runs alongside;
questions run scope_question → user review → answer_question; attached
YouTube videos run download_video (yt-dlp + ffmpeg frames/transcript, no
LLM) → analyze_video (techniques summary onto `module_videos`, then the
work files are deleted); a rack-scoped channel scan (`services/youtube.js`)
matches a channel's uploads to the rack's module names and imports the
picked ones through that same per-video pipeline — via the YouTube Data API
when app_config `youtube_api_key` is set, else a titles-only yt-dlp flat
listing; a module-scoped tutorial search on the module detail page does the
like with a YouTube search (search.list, else yt-dlp ytsearch). Progress
streams over a WebSocket at `/api/ws` (per-user event bus). Every job runs on
the job owner's own LLM account (`user_llm_accounts`); quota exhaustion pauses
that account (or the whole queue for unowned work), budgets make queued work
wait rather than fail. Patch tables snapshot module names with SOFT integer
refs (no FK) so patches keep rendering after modules move, re-analyze, or
disappear; live rows are joined opportunistically at read time.

A **system** is a collection of racks patched together as one instrument
(migration 028). Racks stay the unit of inventory and physical row layout;
`racks.system_id` (+ `system_x`/`system_y`/`system_position`) says which
racks stand together and where. A patch built from a system snapshots EVERY
rack in it at once — that is what makes a cable from a jack in one rack to a
jack in another legal, with no change to the cable rules — and each
`patch_modules` row carries the `rack_id`/`rack_name` it came from, soft like
everything else in a patch, so `rack_layout` matches each placement to an
instance OF THE SAME RACK and the patch outlives the system. Racks on a
system's floor plan may not overlap: the footprint geometry and the rule live
in `services/racks.js`, the layout route enforces it, and the plan slides a
dropped rack clear rather than refusing the drop. `systems.floor_width` /
`floor_height` (migration 029) say how much floor there is to arrange on.

Modules are organised in exactly ONE place — the rack (`rack_rows` /
`rack_row_modules`, the Organize rack page). A patch takes its own COPY of
that arrangement when it is created (`patch_rack_rows` /
`patch_rack_row_modules`, migration 030, `services/patchLayout.js`) and draws
from the copy ever after, so rebuilding a case does not rearrange the patches
already made from it. Cloning copies the patch's frozen arrangement rather
than taking a fresh look at the studio, and
`POST /api/patches/:id/rack-layout/resync` is the only thing that refreshes
it.
