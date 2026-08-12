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
- **Ask questions**: the LLM first decides which of your modules are in scope,
  then answers using their downloaded manuals plus your previous related
  answers as context. Questions, answers, the in-scope modules, and the
  specific input/output jacks the question pertains to are all stored and
  linked in the database.
- **LLM provider is admin-configurable** in the web UI: Claude Code CLI
  (`claude -p`) or Codex CLI (`codex exec`), with an optional model override —
  both use your existing subscription login, no API key needed.
- **Private notes**: attach notes to modules and to specific components; a
  note can be reused across any number of modules/components and is never
  visible to other users.
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
                                        │   analyze_manual / answer_question)
                                        ├── /api/ws WebSocket (live job progress)
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
| `user_modules` | maps users to the modules in their system (per-user quantity); "deleting" a module only unlinks it |
| `manuals` | PDF documents mapped to modules — `user_id NULL` is the shared auto-found manual; rows with a `user_id` are private documents that user attached to their own module instance |
| `module_components` | typed components (`input_jack`, `output_jack`, `knob`, `slider`, `button`, `toggle`, `switch`, `display`, `other`) with `voltage_min`/`voltage_max`/`polarity` |
| `notes` | per-user private notes |
| `note_modules` / `note_components` | attach one note to any number of modules / components |
| `questions` | prompt, answer, status, error |
| `question_modules` | links a question to the modules in scope |
| `question_components` | links a question to the specific jacks it pertains to |
| `jobs` | the async queue (`import`, `find_manual`, `analyze_manual`, `answer_question`) with attempts + errors |
| `app_config` | admin-set LLM provider/model |

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
  documents, and jobs (admins see all jobs).
- LLM answers are rendered as markdown sanitized with DOMPurify.
