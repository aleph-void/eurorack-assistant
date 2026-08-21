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
- `client/src/views/` — one view per route. A MODULE and a PATCH are each a
  PAGE PER THING there is to know about them, not one scrolling page: the
  sections live in `client/src/components/moduledetail/` and
  `client/src/components/patchdetail/` (each with a `use*Facts.js` composable
  for the shared derived state, taking `:module`/`:patch` + id props and
  emitting `reload`), and every section is a route of its own.
  `/modules/:id` is the front plate and the summary; `/components`,
  `/values`, `/parameters`, `/normalizations`, `/switches`, `/routes`,
  `/pairs`, `/expanders`, `/bridges`, `/documents`, `/videos` and `/notes`
  are the rest. EVERY COMPONENT TYPE ALSO HAS A PAGE OF ITS OWN — the list of
  all of a module's components is a page you scroll rather than read, while
  "the knobs" is a page you can take in: `/jacks/input`, `/jacks/output`,
  `/jacks/bidirectional` for the things a cable goes in, `/parts/<type>`
  (knob, slider, button, toggle, switch, display, other) for the rest, all of
  them ONE view (`ModuleComponentTypeView.vue`) over a component type. `/patches/:id` is the picture of the case and the drag that patches a
  cable on it; `/cables`, `/settings`, `/flow`, `/links`, `/scope`,
  `/notes` and `/modules` are the rest (`/patches/:id/config`, the one page
  that used to hold all of those, redirects to `/settings`). Every page reads
  the SAME `GET /api/modules/:id` / `GET /api/patches/:id` and reloads it
  after every write — `useModuleRecord.js` / `usePatchRecord.js` — with ONE
  exception: plugging and unplugging a cable ON THE PICTURE puts the row the
  server just made straight into the payload (`setCables`) instead of reading
  the patch back, because a whole-studio patch is a second of server work and
  two megabytes on the wire and a cable is one row of it. It is safe only
  there — the picture is made of the modules, the cables and the switch
  sections, none of which the server re-derives from a cable, while the cable
  LIST also shows the normalled connections a new cable cancels, so that page
  still re-reads. Every page draws
  `ModuleDetailHeader` / `PatchDetailHeader`, which is what tells the nav
  drawer (`stores/detail.js`) which record's pages to offer at the top of it.
  Arranging a marker needs the plate and the row together, so the mode itself
  is `moduledetail/useArranging.js` and every page that draws a plate has it:
  the module page and the per-type pages draw
  `moduledetail/PanelJacksSection.vue` (the plate, with a scrolling ribbon of
  components beside it, each row a toggle and each marker the same toggle from
  the other side). A per-type page lists ITS type; the module page lists
  EVERY component, because a knob's marker is as wrong as a jack's and the
  front panel page is where a marker is put right. The components page draws
  the plate WHILE ARRANGING because a knob's row is a long way down a long
  table. The components page still
  takes `?arrange=<component id>`.
- PATCHING BY VOICE is an account setting, not a page of a patch: one
  microphone, one footswitch, whatever patch is open. The settings live in
  `voiceSettings.js` (a single reactive, per account, in localStorage and
  never on the server — a deviceId means nothing on another machine) and are
  edited at `/account/voice`; `components/VoicePatchPanel.vue` is the LISTENER
  and is mounted ONCE in App.vue, drawing a bar only while it is switched on
  AND a patch diagram is registered. The patch it acts on is whichever
  diagram registered itself (`voicePatchTarget.js`, claim-counted like
  `stores/detail.js`, with the jack and cable lists handed over as FUNCTIONS
  so a patch nobody talks to never builds them). Switched on with no diagram
  on screen — or the talk key pressed there — it says so in a toast rather
  than looking broken. `/patches/:id/voice` redirects to `/account/voice`.
- `client/tests/views/` — one test file per view; the payloads they are
  tested against are shared in `client/tests/moduleFixtures.js` and
  `client/tests/patchFixtures.js`.
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
- A panel marker with NO component behind it is drawn on the plate, is in
  none of the lists, and — because the untyped fallback colour is the same
  violet an output jack is drawn in — reads as an output jack that has gone
  missing. They came from placement names the analysis echoed whole out of the
  prompt's `- PITCH A (knob)` list: `matchComponent()` in
  services/panelImage.js now reads the type off the name, which is also the
  only way to tell a knob from the jack of the same name apart. The ones
  already stored are put right by `POST /api/modules/:id/panel/relink`
  (`relinkPanelPlacements()`, offered on the module page only while there are
  any): a marker naming a component with no marker becomes that component's
  marker, one naming a component that already has its own is the duplicate it
  looks like and goes.
- Panel pictures are also served at a handful of fixed widths: `?w=<px>` on
  `GET /api/panels/:hash.:ext` renders a WEBP copy once, keeps it in
  `panels/thumbs/`, and serves it under the same immutable policy
  (`services/panelThumbs.js`). Every renderer asks for the size it is about to
  draw — `panelImageUrl()`/`panelThumbUrl()` in `client/src/panelLayout.js`,
  never a bare `panel.url` — because a stored panel is the multi-megabyte file
  the manufacturer published and a patch draws forty of them at once.
- A MENU PARAMETER is a setting a module keeps behind an encoder and a screen
  rather than under a control of its own. The component inventory plus
  `component_values` covers a filter whose LP/BP/HP switch you can see; it
  does not cover Pamela's Pro Workout, whose eight outputs' clock divisions,
  waveforms and levels are all chosen by turning ONE encoder through a menu —
  a dozen settings belonging to a single jack, and jacks are not settable at
  all. So `module_parameters` (+ `module_parameter_options`, migration 036)
  is its own hardware fact: each row hangs off the component it configures
  (usually an output jack) or off nothing at all when it belongs to the whole
  module, and carries the list of settings to pick from. A patch records one
  through the SAME `patch_settings` table — `parameter_id`/`parameter_name`
  beside the component, so a knob still carries exactly one value while a jack
  carries as many as its menu has entries — which is what puts menu settings
  into the patch document every question is asked with, and through
  export/import by name. `services/moduleParameters.js` holds the loader and
  the `find_parameters` job's model pass, which is a PURE FILL like
  `componentDescriber.js`: it adds parameters that are not recorded and fills
  an EMPTY option list, and rewrites nothing.
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
- The picture is MOVED the way a map is: pressing anywhere on the diagram
  that is not a jack and dragging scrolls the box under the pointer (`startPan`
  in PatchDiagram.vue), because a studio is far wider than any screen and the
  scroll bar is a long way from the panel being patched. A cable drag has
  already claimed the gesture by the time the wrap sees it, so patching wins.
  A cable is also what you alt-click to unplug, so its stroke is widened by
  the zoom below 1:1 (`--cable-width`) rather than thinning to a hairline
  nothing can hit.
- ONLY WHAT IS ON SCREEN IS BUILT. A studio is two hundred panels and six
  thousand markers, and the picture is far wider than any screen: the diagram
  renders the panels whose box intersects the scroll viewport (plus a margin),
  their markers, and the cables whose curve passes through it — `measureViewport`
  in PatchDiagram.vue, `cableBounds()` in panelLayout.js. Everything keeps its
  place in the coordinate space, so scrollbars, hit tests and the drag gesture
  are untouched; a viewport that measures nothing (a test renderer with no
  layout) means 'draw everything'. The same rule holds off-screen work
  elsewhere on the page: a collapsed `<details>` is only HIDDEN by the browser,
  so every section that starts closed builds its body the first time it is
  opened (`client/src/lazyPanel.js`; a test that reaches inside one calls
  `openPanels()` from tests/setup.js first). The rack organizer's rows are the
  same rule by hand (`openedRows` in RacksView.vue — a collapsed row's panel
  pictures were downloaded for nothing; tests call `openRackRows()`). The patch payload is held in a
  `shallowRef`, never a deep one — nothing on either page writes into it, and
  deep reactivity doubles every render and triples the memory.
- The patch diagram draws the case, not a poster of it: every panel is as
  wide as the module's HP says it is (`panelWidth()` in panelLayout.js — the
  same measure the rack organizer and a row's capacity use, so a row is drawn
  exactly as wide as its rails; only a module with NO stated HP is measured
  off the shape of its picture, and only that one is held to a fixed maximum
  width), panels sit flush
  against each other and rows sit straight on top of each other (`PANEL_GAP`
  / `ROW_GAP` are 0), a PHYSICAL rack row is never folded in two (it scrolls —
  `wrap` is off whenever rack rows drive the layout), and module names are off
  by default because there is nowhere to put them. The picture zooms instead
  (the SVG's CSS width; the coordinate space never changes, so every hit test
  follows), and can take the whole display ('Full screen', which refits). A
  marker keeps its size ON SCREEN at every zoom (the radius is divided by the
  zoom), and below `CONTROL_ZOOM` only jacks are drawn — a knob at 20% is a
  bead in a curtain of them, and the jacks are what a cable goes in. Panel
  pictures are re-fetched at a new size only once a zoom gesture SETTLES.
  Every module in the rack is drawn by default: the picture is of the case.
  The picture OPENS no smaller than `FIT_MIN_ZOOM` (a whole studio fitted to
  the page is 15%, where nothing can be read or patched) — it scrolls instead;
  'Fit' still fits. Below `MARKER_ZOOM` no markers are drawn at all.
  A jack the picture does not place is OUT OF FRAME and is not drawn
  — nothing hangs below a panel, which is what kept the rows apart; cables
  that end at one are counted in the "not drawn" line instead.
- A patch payload is served WITHOUT PROSE (`describe: false` in
  routes/patches/core.js): what each control does is a megabyte of description
  on a whole-studio patch and none of the patch pages shows it. The LLM-facing
  readers (services/ask.js) and the scope keep the default.
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
- A ROUTING SWITCH is not a mult, and every picture of one has to know the
  difference: a mult COPIES its input to all its siblings, a switch SELECTS
  one of its steps. So the patch payload names its switch sections
  (`switches` — the common jack and its steps, resolved onto instances, from
  `topology.switches`), and the diagram points a section by the SECTION,
  reading BOTH ENDS OF EVERY CABLE: signal ARRIVING at the common (or LEAVING
  a step) runs common → steps, signal LEAVING the common (or arriving at a
  step) runs steps → common, a section driven at both ends or at neither
  stays bidirectional (`multDirections` in PatchDiagram.vue, which excludes
  switch jacks from the mult rule exactly as `services/patchFlow.js` does).
  Reading only the arriving end is the bug that left a common patched ONWARD
  — the many-to-one half of what a switch is for — with its steps still drawn
  as undecided. A plain mult jack a cable LEAVES is an output for the same
  reason; its siblings stay bidirectional, because a mult takes its input at
  exactly one of them and nothing yet says which. The cable pickers say the
  same thing in their hints (`switchRoleOf` in usePatchFacts.js).
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
- A patch NAME is one per account (unique `(user_id, name)`, migration 035;
  the rule and its helpers are `services/patchNames.js`). Only live patches
  count — a patch is really deleted, so its name comes free with it — and it
  is per account, not global: two users may each have an 'Evening drone'.
  A name the USER typed and cannot have is refused (409, the name in the
  message); one the APP made up for them — a clone's `(copy)`, the name an
  imported file carries — takes the next free `<name> 2`, `<name> 3` instead.
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
- WHAT THE BROWSER DOES NOT NEED YET, IT DOES NOT FETCH OR BUILD. Four rules,
  each of them a measured regression that came back:
  - Every view is its OWN CHUNK (`const X = () => import(...)` in router.js;
    LoginView is the one static import). Importing them all made one 567 kB
    file that everybody downloaded to look at their module list; split it is
    138 kB. The voice listener is lazy for the same reason — App.vue fetches
    `VoicePatchPanel.vue` only once voice patching is switched on, which is
    why `voiceSettings.js` imports nothing but `vue`.
  - A picture is asked for at the size it is DRAWN, never at a fixed one
    (`panelThumbUrl`/`panelImageUrl` take the drawn width and the screen's
    density), and every `<img>` that might be off screen carries
    `loading="lazy" decoding="async"`.
  - A list the whole session shares is read once and INVALIDATED where it
    changes, not re-read per page: `refreshRackModules()` in
    `useModuleRecord.js` is called by Modules, Import and Racks. Both module
    and patch payloads are `shallowRef`s.
  - A page that re-reads itself when background work lands watches
    `jobs.finished` (jobs that ENDED), never `jobs.feed.length`: an import is
    hundreds of progress lines and none of them changes what a page shows.
- WORK IS DONE ONCE A FRAME, NOT ONCE AN EVENT. Pointer and scroll events
  arrive far faster than the screen redraws, and in this app one of them
  redraws hundreds of panels or filters six thousand markers: the organizer's
  drag (`aimSoon` in RacksView.vue — leading edge, so a gesture starting has
  no lag) and the diagram's scroll (`onScroll` in PatchDiagram.vue) are both
  rAF-throttled. The diagram's viewport is also SNAPPED OUT to a grid
  (`VIEWPORT_STEP`) and only written when it has really moved, so a scroll of
  three pixels does not invalidate every culled list. A test that drives
  either has to let a frame pass (`frame()` in tests/views/racks.test.js).
  Anything a template calls per item per render is memoized instead
  (`panelMarkers`' WeakMap).
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
find_parameters is asked for by hand, from the module's Menu parameters page;
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
instance OF THE SAME RACK and the patch outlives the system. The FLOOR PLAN is the arrangement, and a patch of a
system DRAWS IT: each rack's floor coordinates are frozen into the snapshot
(`patch_rack_rows.rack_x`/`rack_y`, migration 034, plus the reading order in
`rack_position`), and `floorBlocks()` in client/src/panelLayout.js lays the
studio out from them — racks whose tops are level form a band in left-to-right
order, each band below the deepest rack of the one above. A plan may legally
hold OVERLAPPING racks (the no-overlap rule only bites on the rack being
dragged), so a rack that would land on its neighbour comes to rest flush
beside it instead of on top of it, and a case is drawn as wide as its own
panels are rather than as wide as its rails in HP. `racks.system_position`
only records the order the last floor-plan save happened to send. Racks on a
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
