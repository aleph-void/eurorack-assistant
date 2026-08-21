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
- Schema: the migrations in `server/migrations/` are the source of truth
  (never `sequelize.sync()`); models in `server/src/db/models.js`. Each
  migration is a module exporting `up`/`down` against the helpers in
  `src/db/migrationContext.js`; `src/db/migrate.js` applies, reverts and
  reports on them. `server/migrations/README.md` is the format, and the rules
  (every migration has a working `down`; never edit one that has been
  applied — its `up` source is checksummed in `schema_migrations`).

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
  without rewriting placements. Every view draws a panel into a box `module.hp`
  wide, so a SUPPLIED panel with no stated HP is trimmed on its own terms and
  MEASURED (`boxHp()` in services/panelPixels.js) — the picture sets the
  module's width rather than being stretched to the old one. A stated HP still
  wins and is also the shape the front plate is looked for at. Every panel is
  CUT DOWN TO THE FRONT PLATE as it arrives — an upload or a URL
  (`POST /api/modules/:id/panel`) and the picture the panel job downloads
  alike — by `trimIncomingPanel()` (services/panelImage.js), which cuts bytes
  that are not stored yet and re-bases any markers already worked out on them.
  Cutting resets the crop to full and sets `module_panels.trimmed`, so a
  picture is only ever cut once: cutting twice eats into the hardware.
  `POST /api/modules/:id/panel/trim` does the same to a panel ALREADY stored
  (`trimPanelImage()`, which also re-bases the stored markers), for panels
  from before the cut-on-arrival rule or ones an install without sharp let
  through; the system view's "Trim All Panels" button drives it for a whole
  studio at once through the `trim_panels` job (no LLM involved). A picture
  that cannot be cut (no sharp, an animated format) is still stored whole with
  its crop recorded, so anything drawing a panel as a plain `<img>` must
  offset it with `panelCropStyle()` (client/src/panelLayout.js), or a
  photograph's backdrop is drawn as panel.
- Panel pictures are also served at a handful of fixed widths: `?w=<px>` on
  `GET /api/panels/:hash.:ext` renders a WEBP copy once, keeps it in
  `panels/thumbs/`, and serves it under the same immutable policy
  (`services/panelThumbs.js`). Every renderer asks for the size it is about to
  draw — `panelImageUrl()`/`panelThumbUrl()` in `client/src/panelLayout.js`,
  never a bare `panel.url` — because a stored panel is the multi-megabyte file
  the manufacturer published and a patch draws forty of them at once.
- A DUAL module is two panels of one product joined by a link cable rather
  than by patch cables (Omnitone 7Path's ethernet pair). Neither side is a
  host — that is what makes it not an expander — and BOTH SIDES MAY BE THE
  SAME MODULE RECORD, which is how a dual racked once with quantity 2 pairs
  its own two instances. `module_bridges` (+ the optional
  `module_bridge_jacks` label map, migration 033) declares it on the hardware;
  `services/moduleBridges.js` materializes it into every patch as the
  `patch_module_links` kind 'bridge' the tracers already understand, at patch
  creation and whenever an instance is added. Jack N pairs with jack N BY NAME
  unless the map says otherwise. The wire runs ONE way: the end a cable is
  patched into is the input and the matching jack on the opposite panel is the
  output, which `cableProblem()` enforces (bridged jacks are otherwise exempt
  from the mult rules — they are paired, not copies).
- The patch diagram draws the case, not a poster of it: panels sit flush
  against each other and rows sit straight on top of each other (`PANEL_GAP`
  / `ROW_GAP` are 0), a PHYSICAL rack row is never folded in two (it scrolls —
  `wrap` is off whenever rack rows drive the layout), and module names are off
  by default because there is nowhere to put them. The picture zooms instead
  (the SVG's CSS width; the coordinate space never changes, so every hit test
  follows). A jack the picture does not place is OUT OF FRAME and is not drawn
  — nothing hangs below a panel, which is what kept the rows apart; cables
  that end at one are counted in the "not drawn" line instead.
- Every kind of thing on a panel — the ten COMPONENT_TYPES — has ONE colour,
  and every picture of a panel uses it: the module page's front plate, the
  rack organizer's rows and the patch diagram. `client/src/componentTypes.js`
  holds the list (mirroring `services/manualAnalyzer.js`, which is what the
  server validates against), the labels and the colours; `ComponentLegend.vue`
  draws the key under each picture, listing only the types on it. The colour
  goes on the marker itself (a `fill`/`stroke` attribute, because it is data),
  so no stylesheet may set either or it would win over the type. Each panel
  placement carries the `type` of the component behind it (`panelJson()` in
  services/panelImage.js), so a renderer colours a marker without loading the
  module. A placement with no component behind it has no type and falls back
  to the module page's marker scheme, which is now what supplies CONTRAST (the
  halo) rather than the marker colour.
- Every component type is the same kind of thing to the module page: each has
  its own section — present even when the analysis found none of them, since
  the section is also where one is added by hand — and every component can be
  arranged on the panel, renamed, retyped and removed. There is no read-only
  type. Arranging a component whose marker is OUT OF FRAME (its stored
  position falls outside the panel's crop) first moves it to the middle of the
  plate: arranging is how a marker is put right, so it has to start somewhere
  it can be taken hold of.
- A patch is made of the connections a person can reach, so a connector that
  is not a patch point never appears in one. `isPatchPoint()` (defined in
  `panelLayout.js`, re-exported by `usePatchFacts.js` so the diagram and the
  cable pickers share one rule) filters those out by `port_kind`: an EXPANSION
  HEADER (`'ribbon'` — the connector an expander's ribbon cable plugs into,
  behind the panel), a USB socket (`'usb'` — mini, micro or C; it faces a
  computer or a charger, never another jack in the case) and a memory card
  slot (`'memory_card'` — you put a card in it, you do not patch it). They are
  still components of the module and still shown on the module page.
- Arrangements are saved by REPLACEMENT — `PUT /api/racks/:id/layout` and
  `snapshotRackLayout()` both delete every row of the rack/patch and write the
  ones they were sent. Two of those running at once is a corruption, not a
  lost update: each deletes the rows it can see and then inserts its own
  (neither delete sees the other's insert under READ COMMITTED) and the record
  ends up holding BOTH sets. Every such write takes its rack/patch row
  (`lock: transaction.LOCK.UPDATE`) first, `rack_rows` has a unique
  `(rack_id, position)` (migration 032), and the organizer keeps only one save
  in the air — a save asked for while one is running is made when it lands.
- Failures are said twice: inline where the work is, and as a toast over the
  page (`client/src/toast.js` + `components/ToastStack.vue`, mounted once in
  `App.vue`, styled in `style.css`). `api.js` raises the red one itself for
  every failed request — pass `{ quiet: true }` for a call whose failure is
  not news (a secondary fetch the caller shrugs off; 401 is always silent) —
  and the jobs store raises one when a job ends, green for completed and red
  for failed. A refusal decided in the client (the organizer's HP capacity
  check) calls `toast.error` alongside setting its own message. Repeats of the
  same line count up on the toast already on screen rather than stacking.
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
- Dev DB migrations: `cd server && npm run migrate` (also `npm run
  migrate:status`, `npm run migrate:down`, `node scripts/migrate.js down --to
  <id>`)

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
