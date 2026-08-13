# Eurorack Assistant

An open-source web application for asking LLMs questions about **your** eurorack
modular synthesizer system. Import your module list, and the app automatically
finds each module's user manual, analyzes it into a structured description
(summary, jacks with voltage ranges and polarity, buttons, toggles, …), and then
answers your questions using the actual manuals as context.

It is the web version of the [eurorack-processor](https://github.com/nstarke/eurorack-processor)
scripts: manual research, download, analysis, and question answering are ports
of `find_manuals.py`, `process_manuals.py`, and `ask.py`.

## Features

- **Multi-user**: an admin account (created at setup with a one-time random
  password) can create regular user accounts. Each user has their own system
  (module mappings, quantities, questions); the module records themselves —
  manuals and analyses — are shared, so a module researched once benefits every
  user who has it. Users can also attach additional private PDF documents to
  their own module instances.
- **Import** your modules three ways: newline-delimited free text
  (`Make Noise Maths` or `Make Noise,Maths`), a README.csv-style CSV, or a
  ModularGrid rack URL.
- **Fully asynchronous pipeline** with live progress over a WebSocket:
  1. `import` job — parses the list and creates module records
  2. `find_manual` job (per module) — LLM web research finds the official
     manual PDF, downloads and validates it (archive.org fallback)
  3. `analyze_manual` job (per module) — the LLM reads the manual and returns a
     structured summary plus every component (input/output jacks with voltage
     ranges and unipolar/bipolar polarity, knobs, buttons, toggles, switches, …)
     stored with a `type` field
- **Ask questions**: the LLM first decides which of your modules — and which
  specific components — the question applies to, then you review that scope
  before the answer is generated: add or remove modules and components, and
  choose what to attach (each module's manual is preselected but can be
  deselected, plus your uploaded documents, previous answers, notes tied
  to the selected modules/components, oscilloscope captures, and your patches).
  Questions, answers, the reviewed scope, and the attachments are all stored
  and linked in the database.
- **LLM provider is admin-configurable** in the web UI: Claude Code CLI
  (`claude -p`) or Codex CLI (`codex exec`), with an optional model override —
  both use your existing subscription login, no API key needed.
- **Patches**: record a patch against a snapshot of a rack — the cables, how
  every control is dialed in, what each instance is doing in this patch
  ("LXR #2 — ghost layer") and which bus or layer it belongs to. The snapshot
  keeps rendering after modules move racks, get re-analyzed or are deleted.
- **Signal flow**: patches are traced, not just listed. The analysis records
  each module's internal signal paths, normalled connections, routing switch
  sections, mult groups and stereo pairs, and the patch view follows every
  signal from its source through cables, mult copies, defaults, switches and
  module internals to everywhere it ends up — flagging splits, merges,
  feedback loops and paths that are only one of several alternatives. Only the
  modules the patch actually uses are traced: a patch snapshots the whole rack,
  but a module nothing is plugged into (and whose controls the patch does not
  dial in) is not part of the patch.
- **Ask about a patch**: a question can name one of your patches — from the
  Ask page or the "Ask about this patch" link on the patch itself. The patch is
  attached to the question as a document of its cables, control settings, the
  normalled connections it leaves intact or cancels and the signal flow they
  add up to, and the modules it uses are put in scope with their manuals.
- **Hardware that doesn't fit one panel**: connections that are not 3.5mm
  patch points (MIDI DIN/TRS, USB, S/PDIF, mics, ethernet) are typed as such
  and only patch into their own kind; expander panels joined by ribbon cable
  are declared on the module so signal traces across the pair; bridged pairs
  carry signals between two points of a system; and off-rack gear (a DAW, a
  MIDI interface, the PA) and modules the rack does not hold take part in a
  patch with connection points declared inside it.
- **Paths that depend on a setting**: a switch that chooses which signal is
  normalled to an input, or turns an output from a channel pass-through into a
  mix, is recorded with the control position it needs. Alternatives are shown
  as a selection rather than as signals summing, and recording the switch's
  position in a patch resolves the flow.
- **Private notes**: attach notes to modules, to specific components and to
  patches; a note can be reused across any number of them and is never visible
  to other users.
- **Oscilloscope integration**: an oscilloscope application (such as
  [CVOsc](https://github.com/aleph-void/CVOsc.com)) links itself to your
  account with an OAuth 2.0 device code you approve in the browser, then holds
  a WebSocket open. With a scope connected, a patch maps its channels to the
  jacks of the audio interface in it — an ES-9's inputs are matched and named
  after whatever the patch cables into them — and you can ask the scope for a
  waveform image and the tuner reading taken with it. Captures are filed under
  the patch's notes and can be attached to a question, so the LLM sees the
  measurement alongside the manuals. See
  [docs/oscilloscope-protocol.md](docs/oscilloscope-protocol.md).
- **Job privacy**: background jobs (and their live progress) are visible only
  to the user who triggered them (admins see all jobs). Shared module state
  still benefits everyone.

## Quick start

```sh
./setup.sh
```

The setup script does everything (Ubuntu is the supported target for automatic
installation; on other distros install Docker yourself first):

1. installs `docker.io` + `docker-compose-v2` via apt if missing,
2. installs the `claude` and `codex` CLIs if missing,
3. asks which LLM provider you want and walks you through logging in
   (Claude Pro/Max subscription for Claude Code, ChatGPT for Codex),
4. generates `.env` (random database password), builds the images, migrates
   the database, and
5. creates the `admin` account — **its random password is printed once during
   setup and stored only as a bcrypt hash**. The admin must set their own
   password at the first login.

The app is then at <http://localhost:8080>.

### HTTPS

Pass your domain to the setup script to serve TLS on port 443:

```sh
sudo certbot certonly --standalone -d rack.example.com   # if you don't have certs yet
./setup.sh rack.example.com
```

When certs exist in `/etc/letsencrypt/live/<fqdn>/`, nginx serves
<https://fqdn/> on port 443 with port 80 redirecting to it (the FQDN is
remembered in `.env`, so later plain `./setup.sh` runs keep TLS). Certs are
mounted read-only from the host; after a `certbot renew`, reload nginx with
`docker compose exec nginx nginx -s reload` (a good certbot deploy hook).
With rootless Docker, setup grants `rootlesskit` the `cap_net_bind_service`
capability so it can bind ports 80/443.

The server container mounts `~/.claude` and `~/.codex` from the host so the
CLIs inside the container reuse your subscription logins (override the paths
with `CLAUDE_CONFIG_DIR` / `CODEX_CONFIG_DIR` in `.env`).

Useful afterwards:

```sh
docker compose logs -f server   # watch the job worker
./reset-admin-password.sh       # new random admin password (printed once; forces a change at next login)
docker compose down             # stop (data persists in volumes)
```

## Architecture

```
browser ── nginx (:8080) ──┬── static Vue 3 client (built at image build time)
                           └── /api → Express server (:3000)
                                        ├── PostgreSQL (modules, components,
                                        │   questions, answers, jobs, users)
                                        ├── job worker (import / find_manual /
                                        │   analyze_manual / scope_question /
                                        │   answer_question)
                                        ├── /api/ws WebSocket (live job progress
                                        │   and oscilloscope presence)
                                        ├── /api/devices/ws WebSocket (connected
                                        │   oscilloscope apps, request/response)
                                        └── claude -p / codex exec (LLM calls)
```

- `server/` — Express (ESM). Routes in `src/routes/`, LLM/domain logic in
  `src/services/`, the queue worker in `src/jobs/worker.js`. Sessions are
  httpOnly cookies backed by a `sessions` table; passwords are bcrypt hashes.
- `client/` — Vue 3 + Pinia + Vue Router (Vite). Live job progress arrives over
  the WebSocket and feeds the Jobs page, the Import page, and the nav badge.
- Database schema is created by `server/migrations/*.sql`, applied
  automatically at server start (tracked in `schema_migrations`).

### Data model (main tables)

| table | purpose |
| --- | --- |
| `users` | accounts; `is_admin` flag |
| `modules` | **shared** module records with `manual_status` / `analysis_status` — the manual is found and analyzed once, for everyone |
| `racks` | a user's named racks (unique name per user, `main rack` by default); strictly private to their owner |
| `rack_modules` | maps racks to the modules in them (per-rack quantity); "deleting" a module only unlinks it, and the same module can sit in many racks |
| `manuals` | PDF documents mapped to modules — `user_id NULL` is the shared auto-found manual; rows with a `user_id` are private documents that user attached to their own module instance |
| `module_components` | typed components (`input_jack`, `output_jack`, `bidirectional_jack`, `knob`, `slider`, `button`, `toggle`, `switch`, `display`, `other`) with `voltage_min`/`voltage_max`/`polarity`, a mult `group_label`, and `port_kind` for connections that are not 3.5mm patch points (`midi_din`, `usb`, `microphone`, …) |
| `component_values` | the valid settings of a control: a `min`/`max` pair, or one `enum` row per discrete position |
| `component_routes` | module-internal signal paths (input jack → output jack) — what carries flow across a module; an output no route feeds is a signal generator |
| `component_normalizations` | default connections that hold until something overrides them, with what breaks them (`break_component_id` + `break_on`, for outputs normalled to outputs) |
| `component_switches` / `component_switch_steps` | routing switch sections: a common jack connected to exactly one step jack at a time |
| `component_pairs` | two jacks carrying the two halves of one signal (stereo L/R) |
| `module_expanders` | a host module and an expander panel joined by a ribbon cable, so routes and normals may cross between them |
| `module_path_hints` | what a manual said that could not be stored yet — a signal path running to another panel, or the name of an expander whose record does not exist or is not linked. Materialized whenever resolution becomes possible (the other panel is analyzed, or the two are linked), and kept afterwards so re-analyzing that panel does not lose the paths again |
| `patches` | a patch against a snapshot of a rack (module/component references are soft, so the snapshot survives changes to the rack) |
| `patch_modules` | one row per module instance in the patch, with its `label`, bus (`group_id`) and an `external` flag for off-rack gear |
| `patch_module_ports` | connection points declared inside the patch, for instances with no analyzed module behind them |
| `patch_cables` | a cable between two jacks, plus `note`, `optional`, `stacked` and `alt_group` |
| `patch_settings` | how a control is dialed in for this patch — and what resolves paths that depend on a switch position |
| `patch_groups` | named buses / layers within a patch |
| `patch_module_links` / `patch_module_link_jacks` | instances wired together without patch cables: `expander` pairs and `bridge` pairs (jack N ↔ jack N) |
| `notes` | per-user private notes |
| `note_modules` / `note_components` / `note_patches` | attach one note to any number of modules / components / patches |
| `oauth_clients` | applications allowed to obtain a device token (public clients; `cvosc` is seeded) |
| `device_authorizations` | in-flight device-grant codes: the hashed device code, the short user code, and whether the user approved it |
| `device_tokens` | issued device credentials (access + refresh stored as sha256 hashes), revocable from the web UI |
| `patch_scope_channels` | which scope channel watches which jack of which module instance, per patch — derived from the patch, overridable by hand |
| `captures` / `capture_channels` | a waveform image (content-addressed PNG under `CAPTURES_DIR`) and the tuner reading taken with it, per channel |
| `questions` | prompt, answer, status, error |
| `question_modules` | links a question to the modules in scope (LLM-suggested, then user-reviewed) |
| `question_components` | links a question to the specific components it pertains to (LLM-suggested, then user-reviewed) |
| `question_manuals` / `question_answers` / `question_notes` / `question_captures` | the documents the user attached during review: manual PDFs, previous answers, notes, oscilloscope captures |
| `question_patches` | the patches a question is about — the patch rides along as a document of its cables, settings, normalled connections and signal flow, and the modules it uses go into scope |
| `jobs` | the async queue (`import`, `find_manual`, `analyze_manual`, `scope_question`, `answer_question`) with attempts + errors |
| `app_config` | admin-set LLM provider/model (globally and per job type via `llm_model_<job_type>`) and job worker count (`import_workers`, default 4) |

## Development

Server (Node 20+):

```sh
cd server
npm install
npm test          # vitest + supertest + pg-mem (no database needed)
npm start         # needs DATABASE_URL or POSTGRES_* env vars
```

Client:

```sh
cd client
npm install
npm test          # vitest + vue test utils
npm run dev       # dev server on :5173, proxies /api to :3000
```

Tests never call real LLMs or the network — the CLI backends, `fetch`, and the
database are all injected fakes (`pg-mem` in-memory Postgres for the server).

## Security notes

- The admin password is generated with `crypto.randomBytes` at setup, printed
  once, and stored only as a bcrypt hash. Same for generated user passwords.
- Accounts with a pending forced password change (the admin after setup or a
  reset, any user after an admin password reset) are locked out of every API
  endpoint except the change-password form until they set their own password.
- Users change their own password (current password required) via the username
  link in the nav; admins can reset any other user's password without it.
- Only admins can create users (always non-admin) and change the LLM config.
- Each user sees only their own module mappings, questions, notes, uploaded
  documents, captures, and jobs (admins see all jobs).
- LLM answers are rendered as markdown sanitized with DOMPurify.
- An oscilloscope never sees a password: it gets a token only after the user
  approves its short code in an already-authenticated browser session. Device
  tokens are stored as sha256 hashes, carry a single `oscilloscope` scope, are
  refreshed with rotation (both halves change on every refresh), and are never
  accepted by the session-authenticated routes. Revoking one in the web UI also
  drops the socket it has open.
