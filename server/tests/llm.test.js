import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeBackend,
  CodexBackend,
  createBackend,
  detectQuotaExhaustion,
  parseQuotaResetAt,
  runCli,
  takeQuotaExhaustion,
  DEFAULT_MODELS,
} from '../src/services/llm.js';

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

// Both CLIs report no-login, no-quota and unknown-model on stdout and exit
// non-zero with an empty stderr. An error carrying only stderr says nothing
// at all, which is how an exhausted subscription looked like a mystery across
// a whole rack's worth of panel jobs.
describe('reporting what a CLI actually said when it fails', () => {
  const script = (code, out, err = '') =>
    runCli('sh', ['-c', `printf '%s' "${out}" ; printf '%s' "${err}" >&2 ; exit ${code}`], '');

  it('puts the process output in the error when it exits non-zero', async () => {
    await expect(script(1, "You're out of usage credits.")).rejects.toThrow(
      /sh failed \(exit 1\):\nYou're out of usage credits\./
    );
  });

  it('keeps stderr as well, when there is any', async () => {
    const error = await script(2, 'said on stdout', 'said on stderr').catch((e) => e);
    expect(error.message).toContain('said on stderr');
    expect(error.message).toContain('said on stdout');
  });

  it('says only that it failed when the process said nothing', async () => {
    await expect(script(3, '')).rejects.toThrow(/^sh failed \(exit 3\)$/);
  });

  it('keeps the tail of a long complaint rather than all of it', async () => {
    const error = await script(1, 'x'.repeat(2000)).catch((e) => e);
    expect(error.message.length).toBeLessThan(900);
    expect(error.message).toContain('…');
  });

  it('still resolves with stdout when the process succeeds', async () => {
    await expect(script(0, 'the answer')).resolves.toBe('the answer');
  });
});

// An exhausted subscription is the one failure worth telling the queue about:
// every job behind this one would hit the same wall, three attempts each.
describe('recognizing an exhausted subscription', () => {
  const quota = [
    'Claude AI usage limit reached|1893456000',
    "You've hit your usage limit. Try again in 25 minutes.",
    "You're out of usage credits.",
    'Your credit balance is too low to run this request.',
    'Error: 429 insufficient_quota — you exceeded your current quota',
  ];

  it.each(quota)('reads %s as being out of tokens', (said) => {
    expect(detectQuotaExhaustion(said)).not.toBeNull();
  });

  const other = [
    'Invalid model name: claude-nope-9',
    'Not logged in. Run `claude login` first.',
    'I cannot help with that request.',
    '',
  ];

  it.each(other)('does not read %s as being out of tokens', (said) => {
    expect(detectQuotaExhaustion(said)).toBeNull();
  });

  it('quotes only the line that said so, not the whole transcript', () => {
    const detail = detectQuotaExhaustion(
      'reading the manual…\n  Claude AI usage limit reached|1893456000\nexiting'
    );
    expect(detail.message).toBe('Claude AI usage limit reached|1893456000');
  });

  describe('when the limit lifts', () => {
    const now = Date.parse('2026-08-13T10:00:00Z');

    it('reads the epoch stamp Claude prints', () => {
      const at = parseQuotaResetAt('Claude AI usage limit reached|1893456000', now);
      expect(at).toBe(1893456000 * 1000);
    });

    it('reads a stamp given in milliseconds too', () => {
      const ms = 1893456000000;
      expect(parseQuotaResetAt(`usage limit reached|${ms}`, now)).toBe(ms);
    });

    it('reads a wait given as a duration', () => {
      expect(parseQuotaResetAt('try again in 25 minutes', now)).toBe(now + 25 * 60 * 1000);
      expect(parseQuotaResetAt('try again in about 2 hours', now)).toBe(now + 2 * 60 * 60 * 1000);
    });

    it('reads a wall-clock reset as the next time the clock reads it', () => {
      const at = new Date(parseQuotaResetAt('5-hour limit reached ∙ resets 3pm', now));
      expect(at.getHours()).toBe(15);
      expect(at.getTime()).toBeGreaterThan(now);
    });

    it('says nothing rather than guessing when the message does not', () => {
      expect(parseQuotaResetAt("You're out of usage credits.", now)).toBeNull();
      // A stamp already in the past is no use either.
      expect(parseQuotaResetAt('usage limit reached|1000000000', now)).toBeNull();
    });
  });

  it('marks the error and records it when a CLI run hits the limit', async () => {
    takeQuotaExhaustion(); // whatever an earlier test left behind
    const error = await runCli(
      'sh',
      ['-c', "printf '%s' 'Claude AI usage limit reached|1893456000' ; exit 1"],
      ''
    ).catch((e) => e);
    expect(error.quotaExhausted).toBe(true);
    expect(error.quotaResetAt).toBe(1893456000 * 1000);
    // Also left where the worker collects it, for the callers that swallow
    // a failed LLM call and carry on.
    expect(takeQuotaExhaustion().resetAt).toBe(1893456000 * 1000);
    // Draining it takes it: it stops the queue once, not once per job after.
    expect(takeQuotaExhaustion()).toBeNull();
  });

  it('leaves an ordinary failure unmarked', async () => {
    takeQuotaExhaustion();
    const error = await runCli('sh', ['-c', "printf '%s' 'Invalid model' ; exit 1"], '').catch(
      (e) => e
    );
    expect(error.quotaExhausted).toBeUndefined();
    expect(takeQuotaExhaustion()).toBeNull();
  });
});

describe('createBackend', () => {
  it('creates the right backend per provider', () => {
    expect(createBackend({ provider: 'claude', model: null })).toBeInstanceOf(ClaudeBackend);
    expect(createBackend({ provider: 'codex', model: null })).toBeInstanceOf(CodexBackend);
    expect(() => createBackend({ provider: 'nope' })).toThrow(/Unknown LLM provider/);
  });
});
