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

// Runs `cmd args...`, writing `input` to stdin; resolves with stdout.
export function runCli(cmd, args, input, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
  constructor(model, { run = runCli } = {}) {
    this.model = model || DEFAULT_MODELS.claude;
    this.run = run;
  }

  _exec(prompt, extraArgs = []) {
    const args = ['-p', '--model', this.model, ...extraArgs];
    return this.run('claude', args, prompt);
  }

  // Plain text completion (used for scoping and manual analysis).
  completeText(prompt) {
    return this._exec(prompt);
  }

  // Completion with web search enabled (used for manual research).
  completeTextWithSearch(prompt) {
    return this._exec(prompt, ['--allowedTools', 'WebSearch,WebFetch']);
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
    const manualList = manualPaths.map((p) => `- ${path.resolve(p)}`).join('\n');
    let fullPrompt = prompt;
    if (manualPaths.length > 0) {
      fullPrompt +=
        `\n\nRead the following module manuals before answering. Most are the ` +
        `manual's text extracted to markdown; any .pdf in the list is one whose ` +
        `text could not be extracted:\n${manualList}\n`;
    }
    if (imagePaths.length > 0) {
      const imageList = imagePaths.map((p) => `- ${path.resolve(p)}`).join('\n');
      fullPrompt +=
        `\nAlso look at these captured oscilloscope images. Each pane is one ` +
        `channel, in the order described in the capture document below:\n${imageList}\n`;
    }
    for (const doc of textDocs) {
      fullPrompt += `\n--- Previous answer document: ${doc.name} ---\n\n${doc.text}\n`;
    }
    const dirs = [
      ...new Set([...manualPaths, ...imagePaths].map((p) => path.dirname(path.resolve(p)))),
    ];
    const addDirs = dirs.flatMap((d) => ['--add-dir', d]);
    return this._exec(fullPrompt, ['--allowedTools', 'Read', ...addDirs]);
  }

  // Analyze a single local PDF (used for manual analysis).
  analyzeDocument(prompt, pdfPath) {
    const resolved = path.resolve(pdfPath);
    const fullPrompt = `${prompt}\n\nRead the following manual PDF and base the output on it:\n- ${resolved}\n`;
    return this._exec(fullPrompt, ['--allowedTools', 'Read', '--add-dir', path.dirname(resolved)]);
  }

  // Look at a single local image (used for locating a module's components on
  // its front panel photograph). The Read tool renders PNG/JPEG/GIF/WebP, so
  // this needs nothing beyond the file's directory being allowed.
  analyzeImage(prompt, imagePath) {
    const resolved = path.resolve(imagePath);
    const fullPrompt = `${prompt}\n\nLook at the following image and base the output on it:\n- ${resolved}\n`;
    return this._exec(fullPrompt, ['--allowedTools', 'Read', '--add-dir', path.dirname(resolved)]);
  }
}

export class CodexBackend {
  constructor(model, { run = runCli, tmpdir = os.tmpdir } = {}) {
    this.model = model || null;
    this.run = run;
    this.tmpdir = tmpdir;
  }

  // codex exec prints progress logs to stdout; --output-last-message captures
  // just the agent's final answer.
  async _exec(prompt, extraArgs = []) {
    const outPath = path.join(
      fs.mkdtempSync(path.join(this.tmpdir(), 'codex-')),
      'answer.md'
    );
    try {
      const args = [
        'exec',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '--output-last-message', outPath,
        ...extraArgs,
      ];
      if (this.model) args.push('-m', this.model);
      const result = await this.run('codex', args, prompt);
      const answer = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8').trim() : '';
      if (!answer) throw new Error(`codex CLI returned an empty answer:\n${result}`);
      return answer;
    } finally {
      fs.rmSync(path.dirname(outPath), { recursive: true, force: true });
    }
  }

  completeText(prompt) {
    return this._exec(prompt);
  }

  completeTextWithSearch(prompt) {
    return this._exec(prompt, ['--search']);
  }

  async answerWithDocuments(prompt, manualPaths, textDocs = [], imagePaths = []) {
    const manualList = manualPaths.map((p) => `- ${path.resolve(p)}`).join('\n');
    let fullPrompt = prompt;
    if (manualPaths.length > 0) {
      fullPrompt +=
        `\n\nRead the following module manuals before answering. Most are the ` +
        `manual's text extracted to markdown; any .pdf in the list is one whose ` +
        `text could not be extracted (use a tool such as pdftotext on those):\n${manualList}\n`;
    }
    if (imagePaths.length > 0) {
      // Passed as paths rather than through an image flag: the flag's name
      // has moved between codex releases, and a wrong one fails the whole
      // job. Everything the image shows is also written out in the capture
      // text document, so an agent that cannot open a PNG still has the
      // readings.
      const imageList = imagePaths.map((p) => `- ${path.resolve(p)}`).join('\n');
      fullPrompt +=
        `\nCaptured oscilloscope images (view them if you can; their readings ` +
        `are also written out below):\n${imageList}\n`;
    }
    for (const doc of textDocs) {
      fullPrompt += `\n--- Previous answer document: ${doc.name} ---\n\n${doc.text}\n`;
    }
    return this._exec(fullPrompt);
  }

  analyzeDocument(prompt, pdfPath) {
    const resolved = path.resolve(pdfPath);
    const fullPrompt =
      `${prompt}\n\nRead the following manual PDF and base the output on it ` +
      `(extract its text with a tool such as pdftotext if needed):\n- ${resolved}\n`;
    return this._exec(fullPrompt);
  }

  analyzeImage(prompt, imagePath) {
    const resolved = path.resolve(imagePath);
    const fullPrompt =
      `${prompt}\n\nThe image to look at is at:\n- ${resolved}\n\n` +
      `If you cannot view the image, say so by answering with ` +
      `{"is_panel": false, "components": []} rather than guessing at positions.\n`;
    return this._exec(fullPrompt);
  }
}

export function createBackend({ provider, model }, deps = {}) {
  if (provider === 'claude') return new ClaudeBackend(model, deps);
  if (provider === 'codex') return new CodexBackend(model, deps);
  throw new Error(`Unknown LLM provider: ${provider}`);
}
