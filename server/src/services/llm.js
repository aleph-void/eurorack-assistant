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
export const LLM_JOB_TYPES = ['find_manual', 'analyze_manual', 'scope_question', 'answer_question'];

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
      if (code !== 0) reject(new Error(`${cmd} failed (exit ${code}):\n${stderr}`));
      else resolve(stdout.trim());
    });
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

  // Answer a question given local manual PDFs and extra text documents.
  async answerWithDocuments(prompt, pdfPaths, textDocs = []) {
    const pdfList = pdfPaths.map((p) => `- ${path.resolve(p)}`).join('\n');
    let fullPrompt = `${prompt}\n\nRead the following manual PDFs before answering:\n${pdfList}\n`;
    for (const doc of textDocs) {
      fullPrompt += `\n--- Previous answer document: ${doc.name} ---\n\n${doc.text}\n`;
    }
    const dirs = [...new Set(pdfPaths.map((p) => path.dirname(path.resolve(p))))];
    const addDirs = dirs.flatMap((d) => ['--add-dir', d]);
    return this._exec(fullPrompt, ['--allowedTools', 'Read', ...addDirs]);
  }

  // Analyze a single local PDF (used for manual analysis).
  analyzeDocument(prompt, pdfPath) {
    const resolved = path.resolve(pdfPath);
    const fullPrompt = `${prompt}\n\nRead the following manual PDF and base the output on it:\n- ${resolved}\n`;
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

  async answerWithDocuments(prompt, pdfPaths, textDocs = []) {
    const pdfList = pdfPaths.map((p) => `- ${path.resolve(p)}`).join('\n');
    let fullPrompt =
      `${prompt}\n\nRead the following manual PDFs before answering ` +
      `(extract their text with a tool such as pdftotext if needed):\n${pdfList}\n`;
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
}

export function createBackend({ provider, model }, deps = {}) {
  if (provider === 'claude') return new ClaudeBackend(model, deps);
  if (provider === 'codex') return new CodexBackend(model, deps);
  throw new Error(`Unknown LLM provider: ${provider}`);
}
