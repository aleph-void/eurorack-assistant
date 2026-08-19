import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  accountRuntime,
  accountSummary,
  beginClaudeOauth,
  deleteAccount,
  decryptSecrets,
  encryptSecrets,
  finishClaudeOauth,
  freshClaudeAccessToken,
  getAccount,
  getTokenKey,
  pauseAccount,
  saveApiKey,
  saveClaudeToken,
  saveCodexAuthJson,
  sweepAccountPauses,
} from '../src/services/llmAccounts.js';
import { getLlmSettings } from '../src/services/config.js';
import { createTestApp, createTestDb, createUser } from './helpers.js';

// A fetch stub that records the JSON bodies it was sent and answers the
// Anthropic token endpoint. fakeFetch (helpers) drops the request options,
// and the OAuth tests are about exactly those.
function tokenEndpoint(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: (r.status ?? 200) < 300,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.json ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}

describe('llm account encryption', () => {
  it('round-trips secrets and rejects tampering', () => {
    const stored = encryptSecrets({ token: 'sk-ant-oat01-secret' });
    expect(stored).not.toContain('secret');
    expect(decryptSecrets(stored)).toEqual({ token: 'sk-ant-oat01-secret' });

    const [v, iv, tag, data] = stored.split('$');
    const flipped = data.replace(/^./, data[0] === 'A' ? 'B' : 'A');
    expect(() => decryptSecrets([v, iv, tag, flipped].join('$'))).toThrow();
  });

  it('generates and reuses a key file when no env key is set', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-key-')), 'k.key');
    const env = { LLM_TOKEN_KEY_FILE: file };
    const key = getTokenKey({ env });
    expect(key).toHaveLength(32);
    expect(fs.readFileSync(file, 'utf-8').trim()).toBe(key.toString('hex'));
    // The same file answers with the same key.
    expect(getTokenKey({ env }).equals(key)).toBe(true);
  });
});

describe('claude authorization', () => {
  it('builds a PKCE authorize URL whose state is the verifier', () => {
    const { url, verifier } = beginClaudeOauth();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(parsed.searchParams.get('code')).toBe('true');
    expect(parsed.searchParams.get('state')).toBe(verifier);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('scope')).toContain('user:inference');
  });

  it('exchanges a pasted code#state for tokens and stores them encrypted', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const fetchImpl = tokenEndpoint([
      { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } },
    ]);

    const account = await finishClaudeOauth(db, user.id, 'the-code#the-verifier', 'the-verifier', {
      fetchImpl,
    });

    expect(fetchImpl.calls[0].url).toBe('https://console.anthropic.com/v1/oauth/token');
    expect(fetchImpl.calls[0].body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      state: 'the-verifier',
      code_verifier: 'the-verifier',
    });
    expect(account.kind).toBe('oauth');
    expect(account.credentials).not.toContain('at-1');
    expect(decryptSecrets(account.credentials)).toEqual({
      access_token: 'at-1',
      refresh_token: 'rt-1',
    });
    expect(new Date(account.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a pasted state that is not the verifier we issued', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const fetchImpl = tokenEndpoint([{ json: { access_token: 'at-1' } }]);
    await expect(
      finishClaudeOauth(db, user.id, 'the-code#tampered', 'the-verifier', { fetchImpl })
    ).rejects.toThrow(/Invalid authorization state/);
    expect(fetchImpl.calls).toHaveLength(0); // rejected before any exchange
    expect(await getAccount(db, user.id, 'claude')).toBeNull();
  });

  it('refuses a failed exchange', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const fetchImpl = tokenEndpoint([{ status: 400, json: { error: 'invalid_grant' } }]);
    await expect(
      finishClaudeOauth(db, user.id, 'bad-code', 'v', { fetchImpl })
    ).rejects.toThrow(/answered 400/);
    expect(await getAccount(db, user.id, 'claude')).toBeNull();
  });

  it('hands back a live access token untouched, and refreshes a stale one', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const fetchImpl = tokenEndpoint([
      { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } },
      { json: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } },
    ]);
    let account = await finishClaudeOauth(db, user.id, 'code#v', 'v', { fetchImpl });

    // An hour of life left: no refresh.
    expect(await freshClaudeAccessToken(db, account, { fetchImpl })).toBe('at-1');
    expect(fetchImpl.calls).toHaveLength(1);

    // Pretend the hour passed: refreshed, rotated, and persisted.
    await account.update({ expires_at: new Date(Date.now() - 1000) });
    expect(await freshClaudeAccessToken(db, account, { fetchImpl })).toBe('at-2');
    expect(fetchImpl.calls[1].body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
    });
    account = await getAccount(db, user.id, 'claude');
    expect(decryptSecrets(account.credentials)).toEqual({
      access_token: 'at-2',
      refresh_token: 'rt-2',
    });
  });

  it('accepts only sk-ant-… setup tokens on the paste path', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    await expect(saveClaudeToken(db, user.id, 'nope')).rejects.toThrow(/Invalid token/);
    const account = await saveClaudeToken(db, user.id, 'sk-ant-oat01-abc');
    expect(account.kind).toBe('token');
  });
});

describe('codex authorization', () => {
  it('accepts a pasted auth.json and rejects junk', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    await expect(saveCodexAuthJson(db, user.id, 'not json')).rejects.toThrow(/not valid JSON/);
    await expect(saveCodexAuthJson(db, user.id, '{"hello": 1}')).rejects.toThrow(/neither tokens/);
    const account = await saveCodexAuthJson(
      db,
      user.id,
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } })
    );
    expect(account.kind).toBe('auth_json');
  });
});

describe('account runtime environments', () => {
  it('points claude at a per-user config dir with the stored token', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const account = await saveClaudeToken(db, user.id, 'sk-ant-oat01-abc');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-rt-'));

    const runtime = await accountRuntime(db, account, { dataDir });
    expect(runtime.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-abc');
    expect(runtime.env.CLAUDE_CONFIG_DIR).toBe(path.join(dataDir, 'claude', String(user.id)));
    expect(fs.statSync(runtime.env.CLAUDE_CONFIG_DIR).isDirectory()).toBe(true);
    expect(runtime.sync).toBeNull();
  });

  it('erases the materialized credential from disk when the account is deleted', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-rt-'));
    const account = await saveCodexAuthJson(
      db,
      user.id,
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } })
    );
    // Running a job materializes the live auth.json onto the volume.
    const runtime = await accountRuntime(db, account, { dataDir });
    const authFile = path.join(runtime.env.CODEX_HOME, 'auth.json');
    expect(fs.existsSync(authFile)).toBe(true);

    await deleteAccount(db, user.id, 'codex', { dataDir });
    expect(fs.existsSync(runtime.env.CODEX_HOME)).toBe(false);
    expect(await getAccount(db, user.id, 'codex')).toBeNull();
  });

  it('uses an API key as the provider env var', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-rt-'));

    const claude = await saveApiKey(db, user.id, 'claude', 'sk-ant-api-key-1');
    expect((await accountRuntime(db, claude, { dataDir })).env.ANTHROPIC_API_KEY).toBe(
      'sk-ant-api-key-1'
    );
    const codex = await saveApiKey(db, user.id, 'codex', 'sk-openai-key-1');
    const runtime = await accountRuntime(db, codex, { dataDir });
    expect(runtime.env.OPENAI_API_KEY).toBe('sk-openai-key-1');
    expect(runtime.env.CODEX_HOME).toBe(path.join(dataDir, 'codex', String(user.id)));
  });

  it('materializes codex auth.json once and syncs rotations back', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u', llmAccount: false });
    const account = await saveCodexAuthJson(db, user.id, { tokens: { access_token: 'a1' } });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-rt-'));

    const runtime = await accountRuntime(db, account, { dataDir });
    const file = path.join(runtime.env.CODEX_HOME, 'auth.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ tokens: { access_token: 'a1' } });

    // The CLI rotated its tokens mid-job; sync carries that into the row.
    fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: 'a2' } }));
    await runtime.sync();
    const updated = await getAccount(db, user.id, 'codex');
    expect(decryptSecrets(updated.credentials)).toEqual({
      auth: { tokens: { access_token: 'a2' } },
    });

    // A later run trusts the (fresher) file rather than rewriting it.
    fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: 'a3' } }));
    await accountRuntime(db, updated, { dataDir });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ tokens: { access_token: 'a3' } });
  });
});

describe('per-user provider settings', () => {
  it('resolves provider and model per user over the admin defaults', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });

    // Nothing chosen: the admin defaults rule.
    expect(await getLlmSettings(db, null, user)).toEqual({
      provider: 'claude',
      model: 'claude-fable-5',
    });

    // The user's own job-type override outranks their own default model.
    await db.models.User.update(
      {
        llm_model: 'claude-sonnet-5',
        llm_models: JSON.stringify({ find_manual: 'claude-haiku-4-5' }),
      },
      { where: { id: user.id } }
    );
    let row = await db.models.User.findByPk(user.id);
    expect((await getLlmSettings(db, null, row)).model).toBe('claude-sonnet-5');
    expect((await getLlmSettings(db, 'find_manual', row)).model).toBe('claude-haiku-4-5');

    // A user on their own provider ignores the admin's site model entirely.
    await db.models.User.update({ llm_provider: 'codex' }, { where: { id: user.id } });
    row = await db.models.User.findByPk(user.id);
    expect(await getLlmSettings(db, 'analyze_manual', row)).toEqual({
      provider: 'codex',
      model: 'claude-sonnet-5',
    });
  });
});

describe('account quota pauses', () => {
  it('holds a paused user only while the paused provider is the effective one', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await pauseAccount(db, user.id, 'claude', {
      until: Date.now() + 60 * 60 * 1000,
      reason: 'out of tokens',
    });

    expect((await sweepAccountPauses(db)).held).toEqual(new Set([user.id]));

    // The user moved to codex: the claude wall no longer holds their jobs.
    await db.models.User.update({ llm_provider: 'codex' }, { where: { id: user.id } });
    expect((await sweepAccountPauses(db)).held).toEqual(new Set());
  });

  it('clears an expired pause and reports it resumed', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await pauseAccount(db, user.id, 'claude', { until: Date.now() - 1000, reason: 'was out' });

    const { held, resumed } = await sweepAccountPauses(db);
    expect(held.size).toBe(0);
    expect(resumed).toEqual([{ user_id: user.id, provider: 'claude' }]);
    const account = await getAccount(db, user.id, 'claude');
    expect(account.paused_until).toBeNull();
    expect(accountSummary(account).paused_until).toBeNull();
  });
});

describe('/api/llm', () => {
  it('reports settings and connected accounts without leaking credentials', async () => {
    const { app, aliceCookie } = await createTestApp();
    const res = await request(app).get('/api/llm').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.effective_provider).toBe('claude');
    expect(res.body.accounts.claude).toMatchObject({ connected: true, kind: 'token' });
    expect(res.body.accounts.codex).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-');
  });

  it('lets a user pick their own provider and model, and validates it', async () => {
    const { app, aliceCookie } = await createTestApp();
    const bad = await request(app)
      .put('/api/llm/settings')
      .set('Cookie', aliceCookie)
      .send({ llm_provider: 'gemini' });
    expect(bad.status).toBe(400);

    // A flag-shaped model would be argv-injected into the agent CLI.
    const injected = await request(app)
      .put('/api/llm/settings')
      .set('Cookie', aliceCookie)
      .send({ llm_model: '--dangerously-skip-permissions' });
    expect(injected.status).toBe(400);

    const injectedPerType = await request(app)
      .put('/api/llm/settings')
      .set('Cookie', aliceCookie)
      .send({ llm_models: { answer_question: '-m' } });
    expect(injectedPerType.status).toBe(400);

    const res = await request(app)
      .put('/api/llm/settings')
      .set('Cookie', aliceCookie)
      .send({ llm_provider: 'codex', llm_model: 'gpt-5.1' });
    expect(res.status).toBe(200);
    expect(res.body.effective_provider).toBe('codex');
    expect(res.body.effective_model).toBe('gpt-5.1');
  });

  it('validates the settings body itself, and blanks mean the admin defaults', async () => {
    const { app, aliceCookie } = await createTestApp();
    const put = (body) =>
      request(app).put('/api/llm/settings').set('Cookie', aliceCookie).send(body);

    const nothing = await put({});
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toMatch(/Nothing to update/);

    const asArray = await put({ llm_models: ['claude-opus-5'] });
    expect(asArray.status).toBe(400);
    expect(asArray.body.error).toMatch(/object of job type/);

    const unknownType = await put({ llm_models: { make_coffee: 'claude-opus-5' } });
    expect(unknownType.status).toBe(400);
    expect(unknownType.body.error).toMatch(/Unknown job type: make_coffee/);

    // A blank per-type override means "no override" and is simply dropped.
    await put({ llm_provider: 'codex', llm_model: 'gpt-5.1' });
    const blanked = await put({
      llm_models: { answer_question: 'gpt-5.1-codex', scope_question: '   ' },
    });
    expect(blanked.status).toBe(200);
    expect(blanked.body.llm_models).toEqual({ answer_question: 'gpt-5.1-codex' });

    // Blank provider and model fall back to whatever the admin configured.
    const reset = await put({ llm_provider: '', llm_model: '' });
    expect(reset.status).toBe(200);
    expect(reset.body.llm_provider).toBe('');
    expect(reset.body.effective_provider).toBe('claude');
  });

  it('accepts pasted credentials over HTTP and rejects malformed ones', async () => {
    const { app, aliceCookie } = await createTestApp();
    const post = (path, body) =>
      request(app).post(`/api/llm${path}`).set('Cookie', aliceCookie).send(body);

    const badToken = await post('/claude/token', { token: 'nope' });
    expect(badToken.status).toBe(400);
    expect(badToken.body.error).toMatch(/sk-ant/);
    const token = await post('/claude/token', { token: '  sk-ant-oat01-pasted  ' });
    expect(token.status).toBe(200);
    expect(token.body.accounts.claude).toMatchObject({ connected: true, kind: 'token' });

    const badJson = await post('/codex/auth-json', { auth_json: 'not json' });
    expect(badJson.status).toBe(400);
    expect(badJson.body.error).toMatch(/not valid JSON/);
    const authed = await post('/codex/auth-json', {
      auth_json: JSON.stringify({ OPENAI_API_KEY: 'sk-test-12345678' }),
    });
    expect(authed.status).toBe(200);
    expect(authed.body.accounts.codex).toMatchObject({ connected: true, kind: 'auth_json' });

    const badKey = await post('/codex/api-key', { api_key: 'short' });
    expect(badKey.status).toBe(400);
    const keyed = await post('/codex/api-key', { api_key: 'sk-test-12345678' });
    expect(keyed.status).toBe(200);
    expect(keyed.body.accounts.codex).toMatchObject({ connected: true, kind: 'api_key' });
    expect((await post('/gemini/api-key', { api_key: 'sk-test-12345678' })).status).toBe(400);

    // With both providers connected the summary names them both, and no
    // pasted credential ever appears in it.
    expect(JSON.stringify(keyed.body)).not.toContain('sk-test-12345678');
    expect(JSON.stringify(keyed.body)).not.toContain('sk-ant-oat01-pasted');

    // Only real providers can be resumed or disconnected.
    const badResume = await request(app)
      .post('/api/llm/gemini/resume')
      .set('Cookie', aliceCookie);
    expect(badResume.status).toBe(400);
    const badDelete = await request(app)
      .delete('/api/llm/gemini')
      .set('Cookie', aliceCookie);
    expect(badDelete.status).toBe(400);
  });

  it('shows saved settings on a fresh request, not just in the save response', async () => {
    const { app, aliceCookie } = await createTestApp();
    await request(app)
      .put('/api/llm/settings')
      .set('Cookie', aliceCookie)
      .send({
        llm_provider: 'claude',
        llm_model: 'claude-opus-5',
        llm_models: { analyze_manual: 'claude-fable-5' },
      });

    // A new GET goes through getSessionUser again — the settings must survive
    // the round trip, not only ride along on the PUT's req.user.
    const res = await request(app).get('/api/llm').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.llm_provider).toBe('claude');
    expect(res.body.llm_model).toBe('claude-opus-5');
    expect(res.body.llm_models).toEqual({ analyze_manual: 'claude-fable-5' });
    expect(res.body.effective_model).toBe('claude-opus-5');
  });

  it('walks the claude authorization flow', async () => {
    const fetchImpl = tokenEndpoint([
      { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } },
    ]);
    const { app, aliceCookie, db } = await createTestApp({ fetchImpl });

    const start = await request(app).post('/api/llm/claude/oauth/start').set('Cookie', aliceCookie);
    expect(start.status).toBe(200);
    expect(start.body.url).toContain('https://claude.ai/oauth/authorize');

    // The callback presents the code as `code#state`, and the state it echoes
    // is the verifier that signed the URL.
    const verifier = new URL(start.body.url).searchParams.get('state');
    const finish = await request(app)
      .post('/api/llm/claude/oauth/finish')
      .set('Cookie', aliceCookie)
      .send({ code: `abc#${verifier}` });
    expect(finish.status).toBe(200);
    expect(finish.body.accounts.claude).toMatchObject({ connected: true, kind: 'oauth' });

    expect(fetchImpl.calls[0].body.code_verifier).toBe(verifier);
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    expect(await getAccount(db, alice.id, 'claude')).not.toBeNull();

    // A second finish has nothing pending to finish.
    const again = await request(app)
      .post('/api/llm/claude/oauth/finish')
      .set('Cookie', aliceCookie)
      .send({ code: 'abc#def' });
    expect(again.status).toBe(400);
  });

  it('blocks LLM work at the door when no account is connected', async () => {
    const { app, aliceCookie } = await createTestApp();
    await request(app).delete('/api/llm/claude').set('Cookie', aliceCookie);

    const res = await request(app)
      .post('/api/imports')
      .set('Cookie', aliceCookie)
      .send({ type: 'text', content: 'Make Noise,Maths' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('llm_account_required');

    const ask = await request(app)
      .post('/api/questions')
      .set('Cookie', aliceCookie)
      .send({ prompt: 'What does Maths do?' });
    expect(ask.status).toBe(409);
  });

  it('lifts a quota pause on demand', async () => {
    const { app, aliceCookie, db } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    await pauseAccount(db, alice.id, 'claude', {
      until: Date.now() + 60 * 60 * 1000,
      reason: 'out of tokens',
    });

    const before = await request(app).get('/api/llm').set('Cookie', aliceCookie);
    expect(before.body.accounts.claude.paused_until).toBeTruthy();

    const res = await request(app).post('/api/llm/claude/resume').set('Cookie', aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.accounts.claude.paused_until).toBeNull();
  });
});
