import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeBackend, CodexBackend, createBackend, DEFAULT_MODELS } from '../src/services/llm.js';

function captureRun(response = 'ok') {
  const calls = [];
  const run = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (typeof response === 'function') return response({ cmd, args, input });
    return response;
  };
  run.calls = calls;
  return run;
}

describe('ClaudeBackend', () => {
  it('runs claude -p with the configured model', async () => {
    const run = captureRun('the answer');
    const backend = new ClaudeBackend('claude-sonnet-5', { run });
    expect(await backend.completeText('hello')).toBe('the answer');
    expect(run.calls[0].cmd).toBe('claude');
    expect(run.calls[0].args).toEqual(['-p', '--model', 'claude-sonnet-5']);
    expect(run.calls[0].input).toBe('hello');
  });

  it('defaults the model', () => {
    const backend = new ClaudeBackend(null, { run: captureRun() });
    expect(backend.model).toBe(DEFAULT_MODELS.claude);
  });

  it('enables web search tools for research', async () => {
    const run = captureRun();
    await new ClaudeBackend(null, { run }).completeTextWithSearch('find it');
    expect(run.calls[0].args).toContain('--allowedTools');
    expect(run.calls[0].args).toContain('WebSearch,WebFetch');
  });

  it('passes PDFs via Read tool with --add-dir and inlines text docs', async () => {
    const run = captureRun();
    const backend = new ClaudeBackend(null, { run });
    await backend.answerWithDocuments(
      'Q?',
      ['/data/manuals/a.pdf', '/data/manuals/b.pdf'],
      [{ name: 'prev.md', text: 'previous answer' }]
    );
    const { args, input } = run.calls[0];
    expect(args).toContain('Read');
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(args).toContain('/data/manuals');
    expect(input).toContain('/data/manuals/a.pdf');
    expect(input).toContain('/data/manuals/b.pdf');
    expect(input).toContain('previous answer');
  });

  it('analyzeDocument adds the manual directory', async () => {
    const run = captureRun();
    await new ClaudeBackend(null, { run }).analyzeDocument('Analyze', '/data/manuals/a.pdf');
    expect(run.calls[0].args).toEqual([
      '-p',
      '--model',
      DEFAULT_MODELS.claude,
      '--allowedTools',
      'Read',
      '--add-dir',
      '/data/manuals',
    ]);
    expect(run.calls[0].input).toContain('/data/manuals/a.pdf');
  });
});

describe('CodexBackend', () => {
  function tmpdirFactory() {
    return () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  }

  it('runs codex exec and reads the last-message file', async () => {
    const run = async (cmd, args) => {
      const outIdx = args.indexOf('--output-last-message');
      fs.writeFileSync(args[outIdx + 1], 'codex answer\n');
      run.calls.push({ cmd, args });
      return 'progress logs';
    };
    run.calls = [];
    const backend = new CodexBackend('gpt-5.1-codex', { run, tmpdir: tmpdirFactory() });
    expect(await backend.completeText('hi')).toBe('codex answer');
    const { cmd, args } = run.calls[0];
    expect(cmd).toBe('codex');
    expect(args.slice(0, 5)).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-last-message']);
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.1-codex');
  });

  it('adds --search for research', async () => {
    const run = async (cmd, args) => {
      const outIdx = args.indexOf('--output-last-message');
      fs.writeFileSync(args[outIdx + 1], 'found');
      run.calls.push({ args });
      return '';
    };
    run.calls = [];
    await new CodexBackend(null, { run, tmpdir: tmpdirFactory() }).completeTextWithSearch('x');
    expect(run.calls[0].args).toContain('--search');
  });

  it('throws on an empty answer', async () => {
    const run = async () => '';
    await expect(
      new CodexBackend(null, { run, tmpdir: tmpdirFactory() }).completeText('hi')
    ).rejects.toThrow(/empty answer/);
  });
});

describe('createBackend', () => {
  it('creates the right backend per provider', () => {
    expect(createBackend({ provider: 'claude', model: null })).toBeInstanceOf(ClaudeBackend);
    expect(createBackend({ provider: 'codex', model: null })).toBeInstanceOf(CodexBackend);
    expect(() => createBackend({ provider: 'nope' })).toThrow(/Unknown LLM provider/);
  });
});
