import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeBackend,
  CodexBackend,
  createBackend,
  detectQuotaExhaustion,
  parseClaudeResult,
  parseCodexUsage,
  parseQuotaResetAt,
  runCli,
  stageDocuments,
  takeQuotaExhaustion,
  DEFAULT_MODELS,
  modelNameProblem,
  childEnv,
} from '../src/services/llm.js';

describe('modelNameProblem', () => {
  it('accepts real model names', () => {
    for (const name of ['claude-fable-5', 'gpt-5.1-codex', 'gpt_5', 'Model.2']) {
      expect(modelNameProblem(name)).toBeNull();
    }
  });
  it('rejects a flag-shaped value so it cannot inject a CLI option', () => {
    expect(modelNameProblem('--dangerously-skip-permissions')).toBeTruthy();
    expect(modelNameProblem('-m')).toBeTruthy();
  });
  it('rejects spaces, shell metacharacters and over-long names', () => {
    expect(modelNameProblem('a b')).toBeTruthy();
    expect(modelNameProblem('a;rm -rf /')).toBeTruthy();
    expect(modelNameProblem('x'.repeat(65))).toBeTruthy();
  });
});

describe('childEnv', () => {
  it('passes through allowlisted vars and the credential overlay', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/node', LANG: 'C' };
    const env = childEnv({ CLAUDE_CONFIG_DIR: '/data/llm/claude/1' }, base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/data/llm/claude/1');
  });
  it('never leaks the database URL or the credential-encryption key', () => {
    const base = {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://eurorack:secret@db:5432/eurorack',
      LLM_TOKEN_KEY: 'a'.repeat(64),
      POSTGRES_PASSWORD: 'secret',
    };
    const env = childEnv({ CODEX_HOME: '/data/llm/codex/2' }, base);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.LLM_TOKEN_KEY).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.CODEX_HOME).toBe('/data/llm/codex/2');
  });
});

function captureRun(response = 'ok') {
  const calls = [];
  const run = async (cmd, args, input, options = {}) => {
    calls.push({ cmd, args, input, options });
    if (typeof response === 'function') return response({ cmd, args, input, options });
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
    expect(run.calls[0].args).toEqual([
      '-p',
      '--model',
      'claude-sonnet-5',
      '--output-format',
      'json',
    ]);
    expect(run.calls[0].input).toBe('hello');
  });

  // A CLI too old to know --output-format prints the answer as plain text.
  it('takes stdout as the answer when it is not the JSON envelope', async () => {
    const backend = new ClaudeBackend(null, { run: captureRun('plain text answer') });
    expect(await backend.completeText('hello')).toBe('plain text answer');
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

  it("gives the model a directory holding only this call's documents", async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'manuals-'));
    fs.writeFileSync(path.join(store, 'a.pdf'), 'A');
    fs.writeFileSync(path.join(store, 'b.pdf'), 'B');
    // Another user's upload, sitting in the same content-addressed directory.
    fs.writeFileSync(path.join(store, 'someone-elses.pdf'), 'SECRET');

    // The staged directory only exists while the call is in flight, so its
    // contents are read from inside the run.
    const run = async (cmd, args, input, options) => {
      const dir = args[args.indexOf('--add-dir') + 1];
      run.calls.push({ cmd, args, input, options, jailContents: fs.readdirSync(dir) });
      return 'ok';
    };
    run.calls = [];
    const backend = new ClaudeBackend(null, { run });
    await backend.answerWithDocuments(
      'Q?',
      [path.join(store, 'a.pdf'), path.join(store, 'b.pdf')],
      [{ name: 'prev.md', text: 'previous answer' }]
    );

    const { args, input, options } = run.calls[0];
    expect(args).toContain('Read');
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
    const jail = args[args.indexOf('--add-dir') + 1];
    expect(jail).not.toBe(store);
    expect(options.cwd).toBe(jail);
    // The prompt names the copies, and the directory holds nothing else — the
    // upload belonging to someone else stays out of reach.
    expect(input).toContain(path.join(jail, 'a.pdf'));
    expect(input).toContain(path.join(jail, 'b.pdf'));
    expect(input).not.toContain(store);
    expect(input).not.toContain('someone-elses.pdf');
    expect(run.calls[0].jailContents.sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(input).toContain('previous answer');
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('removes the staged copies when the call is over', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'manuals-'));
    fs.writeFileSync(path.join(store, 'a.pdf'), 'A');
    let jail = null;
    const run = async (cmd, args) => {
      jail = args[args.indexOf('--add-dir') + 1];
      expect(fs.existsSync(path.join(jail, 'a.pdf'))).toBe(true);
      return 'ok';
    };
    await new ClaudeBackend(null, { run }).analyzeDocument('Analyze', path.join(store, 'a.pdf'));
    expect(fs.existsSync(jail)).toBe(false);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('deduplicates documents that share a name', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'manuals-'));
    fs.mkdirSync(path.join(store, 'one'));
    fs.mkdirSync(path.join(store, 'two'));
    fs.writeFileSync(path.join(store, 'one', 'manual.pdf'), '1');
    fs.writeFileSync(path.join(store, 'two', 'manual.pdf'), '2');
    const staged = stageDocuments([
      path.join(store, 'one', 'manual.pdf'),
      path.join(store, 'two', 'manual.pdf'),
    ]);
    expect(fs.readdirSync(staged.dir).sort()).toEqual(['2-manual.pdf', 'manual.pdf']);
    expect(fs.readFileSync(staged.paths[1], 'utf-8')).toBe('2');
    staged.remove();
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('reports the tokens a run spent', async () => {
    const usage = [];
    const run = captureRun(
      JSON.stringify({
        type: 'result',
        result: 'the answer',
        total_cost_usd: 0.0165,
        usage: { input_tokens: 1, output_tokens: 2 },
        modelUsage: {
          'claude-opus-5': {
            inputTokens: 9,
            outputTokens: 38,
            cacheReadInputTokens: 18101,
            cacheCreationInputTokens: 7248,
            canonicalModel: 'claude-opus-5',
          },
        },
      })
    );
    const backend = new ClaudeBackend('claude-opus-5', { run, onUsage: (u) => usage.push(u) });
    expect(await backend.completeText('hi')).toBe('the answer');
    expect(usage).toEqual([
      {
        provider: 'claude',
        model: 'claude-opus-5',
        input_tokens: 9,
        cache_read_tokens: 18101,
        cache_write_tokens: 7248,
        output_tokens: 38,
        total_tokens: 25396,
        cost_usd: 0.0165,
      },
    ]);
  });

  it('sums the models a run delegated to, and names the busiest', () => {
    const { usage } = parseClaudeResult(
      JSON.stringify({
        result: 'done',
        modelUsage: {
          'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5 },
          'claude-opus-5': { inputTokens: 20, outputTokens: 50 },
        },
      })
    );
    expect(usage.model).toBe('claude-opus-5');
    expect(usage.input_tokens).toBe(30);
    expect(usage.output_tokens).toBe(55);
    expect(usage.cost_usd).toBeNull();
  });

  it('does not fail a run because the accounting sink threw', async () => {
    const run = captureRun(JSON.stringify({ result: 'ok', usage: { output_tokens: 3 } }));
    const backend = new ClaudeBackend(null, {
      run,
      onUsage: () => {
        throw new Error('database is down');
      },
    });
    expect(await backend.completeText('hi')).toBe('ok');
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
    expect(args.slice(0, 5)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--json',
    ]);
    expect(args).toContain('--output-last-message');
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.1-codex');
    // Working root is the staged directory, not wherever the server runs.
    expect(args[args.indexOf('--cd') + 1]).toContain('llm-docs-');
  });

  it('reads the turn total out of the JSONL log', () => {
    const log = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":13534,"cached_input_tokens":11008,' +
        '"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    ].join('\n');
    // Codex counts cached input inside input_tokens; the cached part is
    // subtracted back out so "input" means the same thing on both providers.
    expect(parseCodexUsage(log, 'gpt-5.1-codex')).toEqual({
      provider: 'codex',
      model: 'gpt-5.1-codex',
      input_tokens: 2526,
      cache_read_tokens: 11008,
      cache_write_tokens: 0,
      output_tokens: 5,
      total_tokens: 13539,
      cost_usd: null,
    });
  });

  it('shrugs off a log with no usage event', () => {
    expect(parseCodexUsage('not json at all', 'gpt-5.1-codex')).toBeNull();
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
