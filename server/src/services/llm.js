// LLM backends, ported from eurorack-processor's ask.py / find_manuals.py.
// Both shell out to a locally installed agent CLI using its subscription
// login: `claude -p` (Claude Code) or `codex exec` (OpenAI Codex).
//
// What is left here is the two backends and the choice between them. The
// pieces they are built from are files of their own, because each is read
// (and tested) without reference to either backend: services/llmModels.js
// (what may be asked for), services/llmQuota.js (recognising an exhausted
// subscription), services/llmDocuments.js (the per-call document jail),
// services/llmUsage.js (what a run cost) and services/llmProcess.js (the
// child process and the allowlisted environment it gets).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareDirForSandbox } from './sandbox.js';
import { DEFAULT_MODELS } from './llmModels.js';
import { stageDocuments } from './llmDocuments.js';
import { parseClaudeResult, parseCodexUsage, reportUsage } from './llmUsage.js';
import { runCli } from './llmProcess.js';

export * from './llmModels.js';
export * from './llmQuota.js';
export { stageDocuments } from './llmDocuments.js';
export { parseClaudeResult, parseCodexUsage } from './llmUsage.js';
export { CHILD_ENV_ALLOWLIST, childEnv, runCli } from './llmProcess.js';

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

  // Look at a set of related images together (used for the video analysis:
  // the frames sampled out of one video, read in order).
  analyzeImages(prompt, imagePaths) {
    return this._run(
      imagePaths,
      ['--allowedTools', 'Read'],
      (staged) =>
        `${prompt}\n\nLook at the following images, in order, and base the output on them:\n` +
        `${staged.map((file) => `- ${file}`).join('\n')}\n`
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
  // reach. The filesystem is the backstop for that reach — with LLM_SANDBOX_USER
  // set, runCli runs codex as a separate uid that owns none of the server's
  // secrets (services/sandbox.js), so a read of /data/keys is denied by the OS
  // regardless of what the sandbox flag allows.
  async _exec(prompt, extraArgs = [], { cwd = undefined } = {}) {
    // The agent (possibly a different uid) writes its answer here, so the
    // directory has to be reachable across the uid boundary.
    const outDir = fs.mkdtempSync(path.join(this.tmpdir(), 'codex-'));
    prepareDirForSandbox(outDir);
    const outPath = path.join(outDir, 'answer.md');
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

  analyzeImages(prompt, imagePaths) {
    return this._run(
      imagePaths,
      [],
      (staged) =>
        `${prompt}\n\nLook at the following images, in order, and base the output on them ` +
        `(if you cannot view images, work from the rest of the material and say so):\n` +
        `${staged.map((file) => `- ${file}`).join('\n')}\n`
    );
  }
}

export function createBackend({ provider, model }, deps = {}) {
  if (provider === 'claude') return new ClaudeBackend(model, deps);
  if (provider === 'codex') return new CodexBackend(model, deps);
  throw new Error(`Unknown LLM provider: ${provider}`);
}
