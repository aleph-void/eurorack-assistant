# Per-user LLM provider accounts

Every model call the app makes — manual research, manual analysis, panel
placement, question scoping and answering — runs through a locally installed
agent CLI (`claude -p` or `codex exec`). Originally those CLIs used one
subscription login mounted into the server container from the host; now every
user authorizes the app against **their own** provider account, and each job
runs on the credentials of the user who caused it. There is no shared login
to fall back to: a job whose owner has no connected account for their
provider fails immediately with a message saying so, and the Import and Ask
endpoints refuse at the door (HTTP 409, `code: "llm_account_required"`).

## What the user does

Everything lives on **Account → LLM provider** (`/account/llm`), backed by
`/api/llm`:

- **Provider & model** — each user picks `claude` or `codex` for themselves
  (blank = the admin default from the Configuration page), a default model,
  and per-job-type model overrides (e.g. a small model for `extract_manual`,
  stored as JSON in `users.llm_models`). Resolution: the user's override for
  the job type, then their default model, then — only while they are on the
  admin's provider — the admin's site model, then the provider default. The
  admin Configuration page keeps only site-wide settings: default provider
  and model, worker count, token budgets.
- **Claude** — three ways in, most preferred first:
  1. *Authorize with Claude*: an OAuth 2.0 authorization-code + PKCE flow
     against the same public client registration `claude setup-token` uses
     (what ultimately runs with the token *is* the Claude Code CLI). The app
     shows an authorization URL; the user approves on claude.ai in their own
     browser and pastes back the code the callback page displays. The app
     exchanges it for an access/refresh token pair and refreshes the access
     token itself (10 minutes before expiry).
  2. Paste the long-lived `sk-ant-…` token `claude setup-token` prints.
  3. Paste an Anthropic API key.
- **Codex** — the Codex CLI has no headless authorization flow, so the user
  runs `codex login` on their own machine and pastes the contents of
  `~/.codex/auth.json` (or pastes an OpenAI API key).

## How a job picks the credentials up

`services/llmAccounts.js` turns an account row into the environment for one
CLI run (`accountRuntime`), which `jobs/worker.js` lays over the process
environment via `runCli`'s `env` option:

- claude: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`), plus
  `CLAUDE_CONFIG_DIR=/data/llm/claude/<user id>` so CLI state never mixes
  between users.
- codex: `CODEX_HOME=/data/llm/codex/<user id>`, with the pasted `auth.json`
  materialized there on first use. Codex rotates the tokens in that file as
  it runs; after every job the worker syncs the file back into the database
  (`runtime.sync`), so a rebuilt container starts from fresh tokens.

## Storage and security

- Credentials live in `user_llm_accounts` (migration 023), one row per user
  per provider, encrypted with AES-256-GCM. The key comes from the
  `LLM_TOKEN_KEY` env var (64 hex chars) or, by default, a key file generated
  on first use at `/data/keys/llm-token.key` (the `llmkeys` volume) — outside
  the database on purpose, so a database dump alone cannot use the tokens.
  Back the key up with the dump if restored accounts should keep working.
- The API never returns credentials; `/api/llm` reports kind, expiry and
  pause state only. Accounts are strictly self-service — no admin endpoint
  reads or writes another user's credentials.

## Quota exhaustion is per account

When a CLI reports the subscription is out of tokens, the wall belongs to
one user's account, so that account is paused (`paused_until` on the account
row) rather than the whole queue: the job goes back on the queue with its
attempt refunded, that user's queued jobs wait (`sweepAccountPauses` filters
the claim loop), and everyone else's keep running. The pause lifts by itself
at the reset time the provider named (an hour if it named none) or when the
user presses *Resume now*; the owner is told over the WebSocket
(`kind: "llm_account"` events). The old global queue pause remains for work
that belongs to nobody and for manual pauses.
