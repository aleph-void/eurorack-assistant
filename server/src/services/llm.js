// LLM backends, ported from eurorack-processor's ask.py / find_manuals.py.
// Both shell out to a locally installed agent CLI using its subscription
// login: `claude -p` (Claude Code) or `codex exec` (OpenAI Codex).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PROVIDERS = ['claude', 'codex'];

export const KNOWN_MODELS = {
  claude: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  codex: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1', 'gpt-5-codex', 'gpt-5'],
};

export const DEFAULT_MODELS = { claude: 'claude-fable-5', codex: 'gpt-5.1-codex' };

// A model name is written straight into the agent CLI's argv (`--model <name>`
// / `-m <name>`). A value beginning with '-' would be read by the CLI as a
// flag rather than the model, letting a user turn on options the server
// deliberately never passes (a permission or sandbox bypass). So the name is
// held to a conservative shape: it must start with an alphanumeric and contain
// only alphanumerics, dot, underscore and dash. Free-form (not an allowlist)
// so a newly released model still works, but never flag-shaped. Returns an
// error string, or null when the name is acceptable. Blank is allowed by
// callers separately (it means "use the configured default").
export function modelNameProblem(value) {
  const v = String(value);
  if (v.length > 64) return 'model name must be at most 64 characters';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
    return 'model name may only contain letters, digits, dot, underscore and dash';
  }
  return null;
}

// Job types that invoke an LLM backend and accept a per-type model override.
// (import and export_rack never call the LLM.)
//
// extract_manual is on the list for a fallback rather than for its job: it
// reads a PDF with pdftotext and no model at all, and only asks one when that
// comes back empty — a manual that is a scan. Worth its own override for
// exactly that reason: transcribing page images is the cheapest thing here to
// point at a small model.
export const LLM_JOB_TYPES = [
  'find_manual',
  'analyze_manual',
  'extract_manual',
  'panel_image',
  'scope_question',
  'answer_question',
];

// An exhausted subscription is not a failure of the job: every other job in
// the queue is about to hit the same wall, and each one burns three attempts
// finding that out. These recognize the message the CLI prints so the worker
// can stop the queue instead (jobs/worker.js).
//
// Both CLIs say it in prose on stdout, so the text is all there is to go on.
const QUOTA_PATTERNS = [
  /usage limit reached/i,
  /(hit|reached) your usage limit/i,
  /out of usage credits/i,
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /(quota|rate limit) exceeded/i,
  /exceeded your current quota/i,
  /upgrade to increase your usage limit/i,
];

// When the limit lifts, if the CLI says so. Understood forms, in order:
// `usage limit reached|1893456000` (Claude's epoch stamp, seconds or ms),
// `try again in 25 minutes`, and `resets 3am` / `resets at 3:30 PM` (local
// time, the next time the clock reads that).
export function parseQuotaResetAt(text, now = Date.now()) {
  const said = String(text || '');

  const stamp = /usage limit reached\s*\|\s*(\d{9,13})/i.exec(said);
  if (stamp) {
    const value = Number(stamp[1]);
    const ms = value < 1e11 ? value * 1000 : value;
    if (ms > now) return ms;
  }

  const relative = /try again in\s+(?:about\s+)?(\d+)\s*(second|minute|hour)s?/i.exec(said);
  if (relative) {
    const unit = { second: 1000, minute: 60 * 1000, hour: 60 * 60 * 1000 }[
      relative[2].toLowerCase()
    ];
    return now + Number(relative[1]) * unit;
  }

  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(said);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const meridiem = (clock[3] || '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour < 24 && minute < 60) {
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      // A time that has already passed today is tomorrow's.
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.getTime();
    }
  }

  return null;
}

// `{ message, resetAt }` if `text` is a provider saying the subscription is
// out of tokens, otherwise null. resetAt is null when it does not say when.
export function detectQuotaExhaustion(text, now = Date.now()) {
  const said = String(text || '');
  if (!QUOTA_PATTERNS.some((pattern) => pattern.test(said))) return null;
  // The quotable part is the line that matched, not the whole transcript.
  const line =
    said
      .split('\n')
      .map((l) => l.trim())
      .find((l) => QUOTA_PATTERNS.some((pattern) => pattern.test(l))) || said.trim();
  return { message: line.slice(0, 300), resetAt: parseQuotaResetAt(said, now) };
}

// The most recent quota exhaustion any CLI run has reported, held here rather
// than raised through the caller because it does not always survive the trip:
// find_manual, for one, catches a failed research call and carries on with
// the archive.org fallback, so the job can succeed (or fail for an unrelated
// reason) with the subscription nonetheless exhausted. The worker drains this
// after every job.
let quotaExhaustion = null;

export function noteQuotaExhaustion(detail) {
  if (!detail) return;
  // Concurrent runners all hit the wall at once; keep the latest reset time,
  // and a known one over an unknown one.
  if (quotaExhaustion) {
    const known = quotaExhaustion.resetAt ?? 0;
    const incoming = detail.resetAt ?? 0;
    if (incoming <= known) return;
  }
  quotaExhaustion = detail;
}

export function takeQuotaExhaustion() {
  const detail = quotaExhaustion;
  quotaExhaustion = null;
  return detail;
}

// ---------------------------------------------------------------------------
// The document jail
// ---------------------------------------------------------------------------
//
// Every file an agent is allowed to read is copied into a directory made for
// that one call, and that directory is the only one it is given.
//
// The alternative — pointing the agent at the file where it already lives —
// hands it the whole directory, because that is the unit permission comes in.
// Manuals and captures are content-addressed into one flat directory each, so
// "let it read this PDF" and "let it read every PDF in the app" were the same
// sentence: a question of one user's could reach another user's private
// upload, or their oscilloscope captures, simply by looking. Nothing in the
// prompt invited that, and nothing in the prompt prevented it either.
//
// A hard link where the filesystem allows one, a copy where it does not (the
// data volume and /tmp are usually different devices). Names are kept because
// the model reads them — a file called Maths_manual.md says what it is — and
// only deduplicated when two documents would collide.
export function stageDocuments(paths = [], { tmpdir = os.tmpdir } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'llm-docs-'));
  const taken = new Set();
  const staged = [];
  for (const source of paths.map((p) => path.resolve(p))) {
    let name = path.basename(source);
    if (taken.has(name)) {
      for (let n = 2; taken.has(name); n += 1) name = `${n}-${path.basename(source)}`;
    }
    taken.add(name);
    const target = path.join(dir, name);
    try {
      fs.linkSync(source, target);
    } catch {
      // Cross-device (the data volume and /tmp usually are), or a filesystem
      // with no links. A document that cannot be staged at all is a job that
      // fails rather than one that quietly answers without it.
      try {
        fs.copyFileSync(source, target);
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`could not give the model ${source}: ${e.message}`);
      }
    }
    staged.push(target);
  }
  return {
    dir,
    paths: staged,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------
//
// Both CLIs report what a run cost, in different shapes and with different
// completeness, and neither reports anything unless asked. What comes back is
// normalized to one record; a run whose accounting cannot be read is still a
// run that happened, so a missing usage record is never an error.
const tokens = (value) =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;

const usageRecord = (provider, model, counts) => {
  const record = {
    provider,
    model: model || null,
    input_tokens: tokens(counts.input),
    cache_read_tokens: tokens(counts.cacheRead),
    cache_write_tokens: tokens(counts.cacheWrite),
    output_tokens: tokens(counts.output),
    cost_usd: typeof counts.cost === 'number' && Number.isFinite(counts.cost) ? counts.cost : null,
  };
  record.total_tokens =
    record.input_tokens +
    record.cache_read_tokens +
    record.cache_write_tokens +
    record.output_tokens;
  return record;
};

// `claude -p --output-format json` prints one object: the answer under
// `result`, the totals under `usage`, and a per-model breakdown under
// `modelUsage` — which is the one to read, because a run that delegated to
// subagents spent tokens on models the top-level total does not name.
//
// An older CLI that does not know the flag prints the answer as plain text.
// That still works; it just goes unaccounted.
export function parseClaudeResult(stdout, model = null) {
  const raw = String(stdout ?? '').trim();
  if (!raw.startsWith('{')) return { text: raw, usage: null, isError: false };
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { text: raw, usage: null, isError: false };
  }
  if (typeof json?.result !== 'string') return { text: raw, usage: null, isError: false };

  const entries = Object.entries(json.modelUsage ?? {});
  const counts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: json.total_cost_usd };
  let primary = model;
  let mostOutput = -1;
  for (const [name, used] of entries) {
    counts.input += tokens(used?.inputTokens);
    counts.cacheRead += tokens(used?.cacheReadInputTokens);
    counts.cacheWrite += tokens(used?.cacheCreationInputTokens);
    counts.output += tokens(used?.outputTokens);
    // The model that wrote the most is the one the run is attributed to.
    if (tokens(used?.outputTokens) > mostOutput) {
      mostOutput = tokens(used?.outputTokens);
      primary = used?.canonicalModel || name;
    }
  }
  if (entries.length === 0 && json.usage) {
    counts.input = json.usage.input_tokens;
    counts.cacheRead = json.usage.cache_read_input_tokens;
    counts.cacheWrite = json.usage.cache_creation_input_tokens;
    counts.output = json.usage.output_tokens;
  }
  const usage = usageRecord('claude', primary, counts);
  return {
    text: json.result.trim(),
    usage: usage.total_tokens > 0 || usage.cost_usd !== null ? usage : null,
    isError: Boolean(json.is_error),
  };
}

// `codex exec --json` prints JSONL, and the turn's totals arrive on the last
// `turn.completed` event. Codex counts cached input inside `input_tokens`
// rather than beside it, so the cached part is subtracted back out to keep
// one meaning of "input" across providers. No cost is reported.
export function parseCodexUsage(stdout, model = null) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event?.usage || !String(event.type || '').startsWith('turn.')) continue;
    const cacheRead = tokens(event.usage.cached_input_tokens);
    const usage = usageRecord('codex', model, {
      input: Math.max(0, tokens(event.usage.input_tokens) - cacheRead),
      cacheRead,
      cacheWrite: event.usage.cache_write_input_tokens,
      output: event.usage.output_tokens,
      cost: null,
    });
    return usage.total_tokens > 0 ? usage : null;
  }
  return null;
}

// Accounting must never be the reason a job fails: the work is done and the
// tokens are spent whether or not the row lands.
function reportUsage(onUsage, usage) {
  if (!onUsage || !usage) return;
  try {
    Promise.resolve(onUsage(usage)).catch(() => {});
  } catch {
    // a synchronous sink that threw
  }
}

// The only server-process env vars an agent CLI is allowed to inherit. The
// server's own environment carries secrets the agent must never see — the
// database URL (with its password) and LLM_TOKEN_KEY (the key that decrypts
// every user's stored provider credentials) among them — and the agent runs
// untrusted text: a prompt-injected question can ask it to print its
// environment back in the answer. So instead of handing it the whole
// environment, the child gets this fixed set (the things a CLI genuinely needs
// to find its tools, reach the network through a proxy, and validate TLS)
// overlaid with the per-user credential env from accountRuntime. Anything not
// listed here — DATABASE_URL, LLM_TOKEN_KEY, POSTGRES_PASSWORD, … — is absent.
export const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

export function childEnv(overlay = {}, base = process.env) {
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  return { ...env, ...overlay };
}

// Runs `cmd args...`, writing `input` to stdin; resolves with stdout. `cwd` is
// the directory the CLI is started in — the jail above, so a relative path the
// agent tries lands inside it. `env` vars are laid over an allowlisted base
// (NOT the full server environment — see CHILD_ENV_ALLOWLIST) — how a run is
// pointed at one user's credentials (services/llmAccounts.js). `onQuota` hears
// about an exhausted subscription in addition to the global note, so a caller
// running jobs for many users can tell whose it was.
export function runCli(
  cmd,
  args,
  input,
  { timeoutMs = 600000, cwd = undefined, env = undefined, onQuota = null } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: childEnv(env || {}),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to run ${cmd}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      // Both agent CLIs report the things that actually go wrong — no login,
      // no quota, an unknown model, a refusal — on STDOUT, and exit non-zero
      // with nothing on stderr at all. An error built from stderr alone is
      // then the bare string "claude failed (exit 1):", which is how an
      // exhausted subscription managed to look like a mystery for a whole
      // rack's worth of jobs. Whatever the process said is the error.
      const said = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').trim();
      const detail = said.length > 800 ? `…${said.slice(-800)}` : said;
      const error = new Error(`${cmd} failed (exit ${code})${detail ? `:\n${detail}` : ''}`);
      // Out of tokens: recorded for the worker (which stops the queue) and
      // marked on the error, so a caller that sees it knows why without
      // having to read the message.
      const quota = detectQuotaExhaustion(said);
      if (quota) {
        noteQuotaExhaustion(quota);
        try {
          onQuota?.(quota);
        } catch {
          // a listener that threw must not eat the real error
        }
        error.quotaExhausted = true;
        error.quotaResetAt = quota.resetAt;
      }
      reject(error);
    });
    // A CLI that exits before reading its prompt — no login, no tokens left —
    // closes the pipe under this write, and an unhandled EPIPE on a stream is
    // thrown rather than returned. The exit code and what it printed are the
    // real story, so the broken pipe is left to the 'close' handler above.
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

export class ClaudeBackend {
  constructor(model, { run = runCli, tmpdir = os.tmpdir, onUsage = null, env = null, onQuota = null } = {}) {
    this.model = model || DEFAULT_MODELS.claude;
    this.run = run;
    this.tmpdir = tmpdir;
    this.onUsage = onUsage;
    this.env = env;
    this.onQuota = onQuota;
  }

  async _exec(prompt, extraArgs = [], { cwd = undefined } = {}) {
    const args = ['-p', '--model', this.model, '--output-format', 'json', ...extraArgs];
    const stdout = await this.run('claude', args, prompt, {
      cwd,
      env: this.env ?? undefined,
      onQuota: this.onQuota ?? undefined,
    });
    const { text, usage, isError } = parseClaudeResult(stdout, this.model);
    reportUsage(this.onUsage, usage);
    // The CLI usually exits non-zero when it fails, and runCli has already
    // rejected by then; this covers the case where it does not.
    if (isError) throw new Error(`claude reported an error:\n${text}`);
    return text;
  }

  // Every run gets a directory of its own, even the ones with no documents in
  // them: it is the agent's working directory, and a read-only tool reaches
  // into the working directory without asking. `build` receives the staged
  // paths, because the prompt has to name the copies rather than the originals.
  async _run(files, extraArgs, build) {
    const jail = stageDocuments(files, { tmpdir: this.tmpdir });
    try {
      const args = files.length > 0 ? [...extraArgs, '--add-dir', jail.dir] : extraArgs;
      return await this._exec(build(jail.paths), args, { cwd: jail.dir });
    } finally {
      jail.remove();
    }
  }

  // Plain text completion (used for scoping and manual analysis).
  completeText(prompt) {
    return this._run([], [], () => prompt);
  }

  // Completion with web search enabled (used for manual research).
  completeTextWithSearch(prompt) {
    return this._run([], ['--allowedTools', 'WebSearch,WebFetch'], () => prompt);
  }

  // Answer a question given local manual documents, extra text documents, and
  // images (captured oscilloscope waveforms). The Read tool handles PNGs as
  // well as PDFs, so images need nothing beyond their directory being allowed.
  //
  // A manual arrives as the markdown extracted from it wherever that
  // extraction exists, and as the PDF only where it does not — reading a PDF
  // means rendering its pages, which is the expensive way to learn the same
  // thing. Both are files to read, so the caller hands over a mixed list.
  async answerWithDocuments(prompt, manualPaths, textDocs = [], imagePaths = []) {
    const jail = stageDocuments([...manualPaths, ...imagePaths], { tmpdir: this.tmpdir });
    try {
      const manuals = jail.paths.slice(0, manualPaths.length);
      const images = jail.paths.slice(manualPaths.length);
      let fullPrompt = prompt;
      if (manuals.length > 0) {
        fullPrompt +=
          `\n\nRead the following module manuals before answering. Most are the ` +
          `manual's text extracted to markdown; any .pdf in the list is one whose ` +
          `text could not be extracted:\n${manuals.map((p) => `- ${p}`).join('\n')}\n`;
      }
      if (images.length > 0) {
        fullPrompt +=
          `\nAlso look at these captured oscilloscope images. Each pane is one ` +
          `channel, in the order described in the capture document below:\n` +
          `${images.map((p) => `- ${p}`).join('\n')}\n`;
      }
      for (const doc of textDocs) {
        fullPrompt += `\n--- Previous answer document: ${doc.name} ---\n\n${doc.text}\n`;
      }
      return await this._exec(fullPrompt, ['--allowedTools', 'Read', '--add-dir', jail.dir], {
        cwd: jail.dir,
      });
    } finally {
      jail.remove();
    }
  }

  // Analyze a single local PDF (used for manual analysis).
  analyzeDocument(prompt, pdfPath) {
    return this.analyzeDocuments(prompt, [pdfPath]);
  }

  // Analyze related PDFs together. Product-page fallbacks use the maker's
  // page plus Perfect Circuit's page so one model pass can reconcile them.
  analyzeDocuments(prompt, pdfPaths) {
    return this._run(
      pdfPaths,
      ['--allowedTools', 'Read'],
      (staged) =>
        `${prompt}\n\nRead all of the following module-document PDFs and base the output on them:\n` +
        `${staged.map((file) => `- ${file}`).join('\n')}\n`
    );
  }

  // Look at a single local image (used for locating a module's components on
  // its front panel photograph). The Read tool renders PNG/JPEG/GIF/WebP, so
  // this needs nothing beyond the file being in the working directory.
  analyzeImage(prompt, imagePath) {
    return this._run(
      [imagePath],
      ['--allowedTools', 'Read'],
      ([staged]) =>
        `${prompt}\n\nLook at the following image and base the output on it:\n- ${staged}\n`
    );
  }
}

export class CodexBackend {
  constructor(model, { run = runCli, tmpdir = os.tmpdir, onUsage = null, env = null, onQuota = null } = {}) {
    this.model = model || null;
    this.run = run;
    this.tmpdir = tmpdir;
    this.onUsage = onUsage;
    this.env = env;
    this.onQuota = onQuota;
  }

  // codex exec prints its event log to stdout; --output-last-message captures
  // just the agent's final answer, and --json makes the log parseable for the
  // turn's token counts.
  //
  // The jail is codex's working root (--cd). It bounds where relative paths
  // land and what the agent is pointed at, but not what a read-only sandbox
  // may open: codex's read-only mode is read-only about writing, not about
  // reach. Real containment for codex would need a container per job.
  async _exec(prompt, extraArgs = [], { cwd = undefined } = {}) {
    const outPath = path.join(
      fs.mkdtempSync(path.join(this.tmpdir(), 'codex-')),
      'answer.md'
    );
    try {
      const args = [
        'exec',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '--json',
        '--output-last-message', outPath,
        ...(cwd ? ['--cd', cwd] : []),
        ...extraArgs,
      ];
      if (this.model) args.push('-m', this.model);
      const result = await this.run('codex', args, prompt, {
        cwd,
        env: this.env ?? undefined,
        onQuota: this.onQuota ?? undefined,
      });
      reportUsage(this.onUsage, parseCodexUsage(result, this.model));
      const answer = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8').trim() : '';
      if (!answer) throw new Error(`codex CLI returned an empty answer:\n${result}`);
      return answer;
    } finally {
      fs.rmSync(path.dirname(outPath), { recursive: true, force: true });
    }
  }

  // Same shape as the Claude backend's: the documents this call may read are
  // copied into a directory of their own and the prompt names the copies.
  async _run(files, extraArgs, build) {
    const jail = stageDocuments(files, { tmpdir: this.tmpdir });
    try {
      return await this._exec(build(jail.paths), extraArgs, { cwd: jail.dir });
    } finally {
      jail.remove();
    }
  }

  completeText(prompt) {
    return this._run([], [], () => prompt);
  }

  completeTextWithSearch(prompt) {
    return this._run([], ['--search'], () => prompt);
  }

  async answerWithDocuments(prompt, manualPaths, textDocs = [], imagePaths = []) {
    return this._run([...manualPaths, ...imagePaths], [], (staged) => {
      const manuals = staged.slice(0, manualPaths.length);
      const images = staged.slice(manualPaths.length);
      let fullPrompt = prompt;
      if (manuals.length > 0) {
        fullPrompt +=
          `\n\nRead the following module manuals before answering. Most are the ` +
          `manual's text extracted to markdown; any .pdf in the list is one whose ` +
          `text could not be extracted (use a tool such as pdftotext on those):\n` +
          `${manuals.map((p) => `- ${p}`).join('\n')}\n`;
      }
      if (images.length > 0) {
        // Passed as paths rather than through an image flag: the flag's name
        // has moved between codex releases, and a wrong one fails the whole
        // job. Everything the image shows is also written out in the capture
        // text document, so an agent that cannot open a PNG still has the
        // readings.
        fullPrompt +=
          `\nCaptured oscilloscope images (view them if you can; their readings ` +
          `are also written out below):\n${images.map((p) => `- ${p}`).join('\n')}\n`;
      }
      for (const doc of textDocs) {
        fullPrompt += `\n--- Previous answer document: ${doc.name} ---\n\n${doc.text}\n`;
      }
      return fullPrompt;
    });
  }

  analyzeDocument(prompt, pdfPath) {
    return this.analyzeDocuments(prompt, [pdfPath]);
  }

  analyzeDocuments(prompt, pdfPaths) {
    return this._run(
      pdfPaths,
      [],
      (staged) =>
        `${prompt}\n\nRead all of the following module-document PDFs and base the output on them ` +
        `(extract their text with a tool such as pdftotext if needed):\n` +
        `${staged.map((file) => `- ${file}`).join('\n')}\n`
    );
  }

  analyzeImage(prompt, imagePath) {
    return this._run(
      [imagePath],
      [],
      ([staged]) =>
        `${prompt}\n\nThe image to look at is at:\n- ${staged}\n\n` +
        `If you cannot view the image, say so by answering with ` +
        `{"is_panel": false, "components": []} rather than guessing at positions.\n`
    );
  }
}

export function createBackend({ provider, model }, deps = {}) {
  if (provider === 'claude') return new ClaudeBackend(model, deps);
  if (provider === 'codex') return new CodexBackend(model, deps);
  throw new Error(`Unknown LLM provider: ${provider}`);
}
