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
  noteQuotaExhaustion,
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

  it('fails the job rather than quietly answering without a document it cannot stage', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'manuals-'));
    const missing = path.join(store, 'gone.pdf');
    // Neither a link nor a copy can be made of a file that is not there. The
    // whole jail goes with it, so nothing is left behind in /tmp.
    let jail = null;
    const tmpdir = () => {
      jail = store;
      return store;
    };
    expect(() => stageDocuments([missing], { tmpdir })).toThrow(/could not give the model/);
    expect(jail).toBe(store);
    // The staging directory it made for the call was removed on the way out.
    expect(fs.readdirSync(store).filter((name) => name.startsWith('llm-docs-'))).toEqual([]);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('carries the underlying failure as the cause, so a log says what went wrong', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'manuals-'));
    const error = (() => {
      try {
        stageDocuments([path.join(store, 'nope.pdf')], { tmpdir: () => store });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error.cause).toBeInstanceOf(Error);
    expect(String(error.cause.code)).toBe('ENOENT');
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

describe('the global out-of-tokens note', () => {
  it('keeps the latest reset time, and a known one over an unknown one', () => {
    takeQuotaExhaustion(); // start clean
    // Nothing to note is not a note.
    noteQuotaExhaustion(null);
    expect(takeQuotaExhaustion()).toBeNull();

    // Concurrent runners all hit the wall at once. The first one with no
    // reset time is kept until one arrives that knows when the limit lifts.
    noteQuotaExhaustion({ message: 'first', resetAt: null });
    noteQuotaExhaustion({ message: 'second', resetAt: 2000 });
    // …and a later report that knows LESS does not overwrite it.
    noteQuotaExhaustion({ message: 'third', resetAt: null });
    noteQuotaExhaustion({ message: 'fourth', resetAt: 1000 });
    const noted = takeQuotaExhaustion();
    expect(noted.message).toBe('second');
    expect(noted.resetAt).toBe(2000);
    expect(takeQuotaExhaustion()).toBeNull();
  });
});

describe('parseCodexUsage', () => {
  it('reads the last turn that reported any tokens, ignoring the noise around it', () => {
    const stdout = [
      'thinking…',
      'not json at all',
      '{ malformed',
      JSON.stringify({ type: 'item.completed', usage: { input_tokens: 99 } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
      }),
    ].join('\n');
    const usage = parseCodexUsage(stdout, 'gpt-5.1-codex');
    expect(usage.provider).toBe('codex');
    expect(usage.model).toBe('gpt-5.1-codex');
    // The cached half is reported separately, not twice.
    expect(usage.input_tokens).toBe(60);
    expect(usage.cache_read_tokens).toBe(40);
    expect(usage.output_tokens).toBe(7);
  });

  it('is null when nothing in the output accounts for anything', () => {
    expect(parseCodexUsage('', 'gpt-5.1-codex')).toBeNull();
    expect(parseCodexUsage('just prose', 'gpt-5.1-codex')).toBeNull();
    // A turn that reports zero tokens is not an accounting record.
    expect(
      parseCodexUsage(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }),
        'gpt-5.1-codex'
      )
    ).toBeNull();
  });
});

describe('parseClaudeResult', () => {
  it('treats anything that is not a result envelope as the answer itself', () => {
    // Plain prose.
    expect(parseClaudeResult('the answer')).toEqual({
      text: 'the answer',
      usage: null,
      isError: false,
    });
    // Something that starts like JSON but is not.
    expect(parseClaudeResult('{ not json').text).toBe('{ not json');
    // Valid JSON that is the ANSWER rather than the envelope — every analysis
    // prompt asks for a JSON object, so this is the common case.
    const answer = JSON.stringify({ components: [] });
    expect(parseClaudeResult(answer)).toEqual({ text: answer, usage: null, isError: false });
  });
});

describe('CodexBackend', () => {
  // codex writes its final answer to the file named by --output-last-message
  // rather than to stdout, so a fake run has to put it there. Returns the
  // captured calls alongside.
  function codexRun(answer = 'the answer', stdout = '') {
    const calls = [];
    const run = async (cmd, args, input, options = {}) => {
      calls.push({ cmd, args, input, options });
      const at = args.indexOf('--output-last-message');
      if (at >= 0 && answer !== null) fs.writeFileSync(args[at + 1], answer);
      return stdout;
    };
    run.calls = calls;
    return run;
  }

  it('runs codex exec read-only, with the model and the answer file', async () => {
    const run = codexRun('an answer');
    expect(await new CodexBackend('gpt-5.1-codex', { run }).completeText('hi')).toBe('an answer');
    const { cmd, args, input } = run.calls[0];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--json');
    expect(args.slice(args.indexOf('-m'))).toEqual(['-m', 'gpt-5.1-codex']);
    expect(input).toBe('hi');
  });

  it('leaves the model out when none is configured, and adds --search on demand', async () => {
    const run = codexRun();
    await new CodexBackend(null, { run }).completeTextWithSearch('find it');
    expect(run.calls[0].args).not.toContain('-m');
    expect(run.calls[0].args).toContain('--search');
  });

  it('takes the answer file away with the jail, whatever happened', async () => {
    const seen = [];
    const run = codexRun('done');
    const backend = new CodexBackend(null, { run });
    await backend.completeText('hi');
    // --cd is the document jail; --output-last-message is its own directory.
    const { args } = run.calls[0];
    const jail = args[args.indexOf('--cd') + 1];
    const answerFile = args[args.indexOf('--output-last-message') + 1];
    seen.push(jail, path.dirname(answerFile));
    for (const dir of seen) expect(fs.existsSync(dir)).toBe(false);
  });

  it('fails loudly when codex exits cleanly having written no answer', async () => {
    // An empty answer file is the shape a refusal or a crashed turn takes,
    // and a job that "succeeded" with an empty string is the worst outcome.
    const run = codexRun(null, 'some event log');
    await expect(new CodexBackend(null, { run }).completeText('hi')).rejects.toThrow(
      /codex CLI returned an empty answer/
    );
  });

  it('names every staged document in the prompt it builds', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-docs-'));
    const manual = path.join(store, 'maths.pdf');
    const frameA = path.join(store, 'frame-1.png');
    const frameB = path.join(store, 'frame-2.png');
    for (const f of [manual, frameA, frameB]) fs.writeFileSync(f, 'x');
    const run = codexRun('ok');
    const backend = new CodexBackend(null, { run });

    await backend.analyzeDocument('Analyze', manual);
    expect(run.calls[0].input).toContain('- ');
    expect(run.calls[0].input).toContain('maths.pdf');
    expect(run.calls[0].input).toContain('pdftotext');

    await backend.analyzeImage('Locate', frameA);
    // A model that cannot open images must say so rather than invent
    // positions, so the prompt gives it the words to say it with.
    expect(run.calls[1].input).toContain('frame-1.png');
    expect(run.calls[1].input).toContain('"is_panel": false');

    await backend.analyzeImages('Watch', [frameA, frameB]);
    expect(run.calls[2].input).toContain('frame-1.png');
    expect(run.calls[2].input).toContain('frame-2.png');
    expect(run.calls[2].input).toContain('in order');

    await backend.answerWithDocuments(
      'Why is it quiet?',
      [manual],
      [{ name: 'Earlier answer', text: 'because of the VCA' }],
      [frameA]
    );
    const asked = run.calls[3].input;
    expect(asked).toContain('Why is it quiet?');
    expect(asked).toContain('module manuals');
    expect(asked).toContain('oscilloscope captures');
    expect(asked).toContain('--- Previous answer document: Earlier answer ---');
    expect(asked).toContain('because of the VCA');

    // Nothing to attach: the prompt is just the question.
    await backend.answerWithDocuments('Plain question', [], [], []);
    expect(run.calls[4].input).toBe('Plain question');

    fs.rmSync(store, { recursive: true, force: true });
  });

  it('reports what a codex run cost', async () => {
    const usage = [];
    const run = codexRun(
      'the answer',
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 30 },
      })
    );
    await new CodexBackend('gpt-5.1-codex', { run, onUsage: (u) => usage.push(u) }).completeText('hi');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.1-codex',
      input_tokens: 300,
      cache_read_tokens: 200,
      output_tokens: 30,
    });
  });

  it('carries the per-user credential environment and the quota listener through', async () => {
    const run = codexRun();
    const onQuota = () => {};
    await new CodexBackend(null, { run, env: { CODEX_HOME: '/data/llm/7' }, onQuota }).completeText(
      'hi'
    );
    expect(run.calls[0].options.env).toEqual({ CODEX_HOME: '/data/llm/7' });
    expect(run.calls[0].options.onQuota).toBe(onQuota);
  });
});

describe('ClaudeBackend images', () => {
  function captureImageRun() {
    const calls = [];
    const run = async (cmd, args, input, options = {}) => {
      calls.push({ cmd, args, input, options });
      return JSON.stringify({ type: 'result', result: 'ok' });
    };
    run.calls = calls;
    return run;
  }

  it('gives the Read tool the image it is asked to look at, and nothing else', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-images-'));
    const one = path.join(store, 'panel.png');
    const two = path.join(store, 'frame-2.png');
    for (const f of [one, two]) fs.writeFileSync(f, 'x');
    const run = captureImageRun();
    const backend = new ClaudeBackend(null, { run });

    await backend.analyzeImage('Locate the jacks', one);
    const args = run.calls[0].args;
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read');
    // …pointed at the jail the picture was copied into, and nowhere else —
    // never at the panels directory where every user's uploads live.
    const added = args[args.indexOf('--add-dir') + 1];
    expect(added).toMatch(/llm-docs-/);
    expect(added).not.toBe(store);
    expect(run.calls[0].input).toContain('panel.png');

    await backend.analyzeImages('Watch these', [one, two]);
    expect(run.calls[1].args).toContain('--allowedTools');
    expect(run.calls[1].input).toContain('panel.png');
    expect(run.calls[1].input).toContain('frame-2.png');
    expect(run.calls[1].input).toContain('in order');

    fs.rmSync(store, { recursive: true, force: true });
  });

  it('attaches manuals, captures and previous answers to one question', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-answer-'));
    const manual = path.join(store, 'maths.md');
    const capture = path.join(store, 'capture-1.png');
    for (const f of [manual, capture]) fs.writeFileSync(f, 'x');
    const run = captureImageRun();
    await new ClaudeBackend(null, { run }).answerWithDocuments(
      'Why is it quiet?',
      [manual],
      [{ name: 'Earlier answer', text: 'because of the VCA' }],
      [capture]
    );
    const asked = run.calls[0].input;
    expect(asked).toContain('Why is it quiet?');
    expect(asked).toContain('maths.md');
    expect(asked).toContain('capture-1.png');
    expect(asked).toContain('An oscilloscope capture is one pane per');
    expect(asked).toContain('--- Previous answer document: Earlier answer ---');
    fs.rmSync(store, { recursive: true, force: true });
  });
});
