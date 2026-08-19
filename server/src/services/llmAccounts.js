// Per-user LLM provider accounts: how a user authorizes the app to run the
// agent CLIs (`claude`, `codex`) on their own subscription, and how a job
// run picks those credentials up.
//
// The mechanics differ per provider because the CLIs differ:
//
// claude — Claude Code reads a token from the CLAUDE_CODE_OAUTH_TOKEN
//   environment variable (or an API key from ANTHROPIC_API_KEY). Tokens come
//   from Anthropic's OAuth authorization-code + PKCE flow — the same flow
//   `claude setup-token` walks — which works headless: the user opens the
//   authorization URL in their own browser, approves, and pastes the code
//   the callback page shows them back into the app. The app exchanges the
//   code for an access/refresh token pair and refreshes it itself. A user
//   who prefers to run `claude setup-token` on their own machine can paste
//   the long-lived token it prints instead.
//
// codex — the Codex CLI keeps its login in $CODEX_HOME/auth.json and has no
//   headless authorization flow, so the user pastes the auth.json a
//   `codex login` wrote on their own machine (or an OpenAI API key). The
//   file is materialized into a per-user CODEX_HOME on the data volume;
//   codex refreshes the tokens in place there, and what the file says after
//   a run is synced back to the database so a rebuilt container starts from
//   fresh tokens rather than stale ones.
//
// Credentials are AES-256-GCM encrypted at rest with a key that lives
// outside the database (env LLM_TOKEN_KEY, or a generated key file on the
// data volume), so the database import/export feature moves accounts without
// moving usable secrets.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Op } from 'sequelize';
import { PROVIDERS } from './llm.js';
import { getConfig, getLlmSettings } from './config.js';
import {
  sandboxConfig,
  prepareDirForSandbox,
  prepareFileForSandbox,
  prepareTreeForSandbox,
} from './sandbox.js';

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

const KEY_BYTES = 32;

// Key files already read (or created), by resolved path. The key never
// changes underneath a running server, so one read is enough.
const keyCache = new Map();

export function resolveKeyFile(env = process.env) {
  return env.LLM_TOKEN_KEY_FILE || '/data/keys/llm-token.key';
}

// The encryption key: env LLM_TOKEN_KEY (64 hex chars) when set, otherwise a
// key file on the data volume, generated on first use. The file sits beside
// the app's other private data but outside the database, which is the point.
export function getTokenKey({ env = process.env } = {}) {
  const fromEnv = String(env.LLM_TOKEN_KEY || '').trim();
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) {
      throw new Error('LLM_TOKEN_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(fromEnv, 'hex');
  }
  const file = path.resolve(resolveKeyFile(env));
  if (keyCache.has(file)) return keyCache.get(file);
  let key;
  try {
    const hex = fs.readFileSync(file, 'utf-8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error(`the key in ${file} is not 64 hex characters`);
    }
    key = Buffer.from(hex, 'hex');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    key = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600 });
  }
  keyCache.set(file, key);
  return key;
}

export function encryptSecrets(secrets, opts = {}) {
  const key = getTokenKey(opts);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('$');
}

export function decryptSecrets(text, opts = {}) {
  const [version, ivB64, tagB64, dataB64] = String(text || '').split('$');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('stored credentials are not in a readable format');
  }
  const key = getTokenKey(opts);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf-8'));
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function getAccount(db, userId, provider) {
  return db.models.UserLlmAccount.findOne({ where: { user_id: userId, provider } });
}

// Create or replace the user's account for one provider. Replacing clears
// any quota pause: new credentials are a new subscription as far as the
// queue is concerned.
export async function saveAccount(
  db,
  userId,
  provider,
  kind,
  secrets,
  { expiresAt = null, ...keyOpts } = {}
) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Invalid provider: ${provider}`);
  const credentials = encryptSecrets(secrets, keyOpts);
  const existing = await getAccount(db, userId, provider);
  const fields = {
    kind,
    credentials,
    expires_at: expiresAt,
    paused_until: null,
    paused_reason: '',
  };
  if (existing) return existing.update(fields);
  return db.models.UserLlmAccount.create({ user_id: userId, provider, ...fields });
}

// Disconnecting an account has to erase the live credential, not just the
// database row. accountRuntime materializes the credential into a per-user
// directory on the data volume (the codex auth.json the CLI rotates in place,
// the claude config dir), and that copy is what a job actually runs on. Left
// behind it makes "disconnected" a lie — the tokens sit there in cleartext,
// and because the codex path only rewrites auth.json when it is missing, a
// stale file would even be used in preference to a freshly connected account.
// So the row and the directory go together.
export async function deleteAccount(db, userId, provider, opts = {}) {
  const dataDir = opts.dataDir || resolveLlmDataDir(opts.env || process.env);
  const dir = path.join(dataDir, provider, String(userId));
  fs.rmSync(dir, { recursive: true, force: true });
  return db.models.UserLlmAccount.destroy({ where: { user_id: userId, provider } });
}

// Every on-disk credential a user has, across providers — used when the whole
// account is deleted, so nothing of theirs is left materialized on the volume.
export function purgeUserLlmData(userId, opts = {}) {
  const dataDir = opts.dataDir || resolveLlmDataDir(opts.env || process.env);
  for (const provider of PROVIDERS) {
    fs.rmSync(path.join(dataDir, provider, String(userId)), { recursive: true, force: true });
  }
}

// What the API may say about an account: everything but the secrets.
export function accountSummary(account, now = Date.now()) {
  if (!account) return null;
  const pausedUntil =
    account.paused_until && new Date(account.paused_until).getTime() > now
      ? new Date(account.paused_until).toISOString()
      : null;
  return {
    provider: account.provider,
    kind: account.kind,
    connected: true,
    expires_at: account.expires_at ? new Date(account.expires_at).toISOString() : null,
    paused_until: pausedUntil,
    paused_reason: pausedUntil ? account.paused_reason || '' : '',
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Claude authorization (OAuth 2.0 authorization code + PKCE)
// ---------------------------------------------------------------------------

// Claude Code's public OAuth registration — the same one `claude setup-token`
// authorizes against, because what ultimately runs with the token here is the
// Claude Code CLI itself. The callback page at console.anthropic.com shows
// the user a code to copy rather than redirecting anywhere, which is what
// lets the flow finish from a server with no registered callback of its own.
export const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
};

const base64url = (buf) => buf.toString('base64url');

// Start the flow: the URL to send the user's browser to, and the PKCE
// verifier the finish step must present. The verifier doubles as the state,
// which is how the CLI's own flow does it.
export function beginClaudeOauth({ oauth = CLAUDE_OAUTH } = {}) {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    code: 'true',
    client_id: oauth.clientId,
    response_type: 'code',
    redirect_uri: oauth.redirectUri,
    scope: oauth.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  });
  return { url: `${oauth.authorizeUrl}?${params}`, verifier };
}

async function exchangeClaudeToken(body, { oauth = CLAUDE_OAUTH, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: oauth.clientId, ...body }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic token endpoint answered ${res.status}: ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Anthropic token endpoint answered with something other than JSON');
  }
  if (!json.access_token) throw new Error('Anthropic token endpoint returned no access token');
  return json;
}

// Finish the flow with the code the user pasted. The callback page presents
// it as `code#state`; a bare code is accepted too.
export async function finishClaudeOauth(db, userId, pastedCode, verifier, opts = {}) {
  const [code, state] = String(pastedCode || '')
    .trim()
    .split('#');
  if (!code) throw new Error('Invalid authorization code');
  if (!verifier) throw new Error('No authorization in progress — start again');
  // The state the callback echoes is our own PKCE verifier (beginClaudeOauth
  // uses it as the state). PKCE already blocks code injection because the
  // exchange sends our code_verifier, but rejecting a mismatched state closes
  // the door earlier and makes a tampered paste an explicit error.
  if (state && state !== verifier) {
    throw new Error('Invalid authorization state — start the authorization again');
  }
  const json = await exchangeClaudeToken(
    {
      grant_type: 'authorization_code',
      code,
      state: state || verifier,
      redirect_uri: (opts.oauth || CLAUDE_OAUTH).redirectUri,
      code_verifier: verifier,
    },
    opts
  );
  const now = opts.now ?? Date.now();
  return saveAccount(
    db,
    userId,
    'claude',
    'oauth',
    { access_token: json.access_token, refresh_token: json.refresh_token || null },
    {
      expiresAt: json.expires_in ? new Date(now + Number(json.expires_in) * 1000) : null,
      ...opts,
    }
  );
}

// How long before the recorded expiry a token is treated as already stale.
// A job can sit behind a long prompt for minutes; refreshing early keeps the
// token alive for the whole run.
const REFRESH_SKEW_MS = 10 * 60 * 1000;

// The access token for a claude oauth account, refreshed first if it is
// about to expire. Returns the token; updates the row when it refreshed.
export async function freshClaudeAccessToken(db, account, opts = {}) {
  const secrets = decryptSecrets(account.credentials, opts);
  const now = opts.now ?? Date.now();
  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : null;
  const stale = expiresAt !== null && expiresAt - REFRESH_SKEW_MS <= now;
  if (!stale || !secrets.refresh_token) return secrets.access_token;

  const json = await exchangeClaudeToken(
    { grant_type: 'refresh_token', refresh_token: secrets.refresh_token },
    opts
  );
  const refreshed = {
    access_token: json.access_token,
    // Anthropic rotates the refresh token on use; keep whichever is newest.
    refresh_token: json.refresh_token || secrets.refresh_token,
  };
  await account.update({
    credentials: encryptSecrets(refreshed, opts),
    expires_at: json.expires_in ? new Date(now + Number(json.expires_in) * 1000) : null,
  });
  return refreshed.access_token;
}

// A long-lived token from `claude setup-token`, pasted in.
export async function saveClaudeToken(db, userId, token, opts = {}) {
  const value = String(token || '').trim();
  if (!value.startsWith('sk-ant-')) {
    throw new Error('Invalid token: expected the sk-ant-… token `claude setup-token` prints');
  }
  return saveAccount(db, userId, 'claude', 'token', { token: value }, opts);
}

// A plain API key, for either provider.
export async function saveApiKey(db, userId, provider, apiKey, opts = {}) {
  const value = String(apiKey || '').trim();
  if (value.length < 8) throw new Error('Invalid API key');
  if (!PROVIDERS.includes(provider)) throw new Error(`Invalid provider: ${provider}`);
  return saveAccount(db, userId, provider, 'api_key', { api_key: value }, opts);
}

// ---------------------------------------------------------------------------
// Codex authorization
// ---------------------------------------------------------------------------

// The pasted content of an auth.json that `codex login` wrote.
export async function saveCodexAuthJson(db, userId, authJson, opts = {}) {
  let parsed = authJson;
  if (typeof authJson === 'string') {
    try {
      parsed = JSON.parse(authJson);
    } catch {
      throw new Error('Invalid auth.json: not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid auth.json: expected a JSON object');
  }
  if (!parsed.tokens && !parsed.OPENAI_API_KEY) {
    throw new Error('Invalid auth.json: it has neither tokens nor an OPENAI_API_KEY');
  }
  return saveAccount(db, userId, 'codex', 'auth_json', { auth: parsed }, opts);
}

// ---------------------------------------------------------------------------
// Runtime: turning an account into the environment a CLI run needs
// ---------------------------------------------------------------------------

export function resolveLlmDataDir(env = process.env) {
  return env.LLM_DIR || '/data/llm';
}

function ensurePrivateDir(dataDir, provider, userId, config = sandboxConfig()) {
  const providerDir = path.join(dataDir, provider);
  const dir = path.join(providerDir, String(userId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // When the CLI runs as a separate sandbox user, it still has to read its own
  // credential home (and, for codex, rewrite the auth.json it rotates), so the
  // home is handed across the uid boundary via the shared group — EVERY level
  // of it. The sandbox uid needs traverse rights on the whole path (a 0700
  // provider dir between the root and the home denies everything below it),
  // and a home that predates the sandbox is full of CLI state owned privately
  // by the server user, which the tree repair opens up. Without a sandbox all
  // of this is a no-op and the dirs stay 0700.
  prepareDirForSandbox(dataDir, config);
  prepareDirForSandbox(providerDir, config);
  prepareTreeForSandbox(dir, config);
  return dir;
}

// The environment variables one job's CLI runs should see, plus a `sync`
// hook the worker calls when the job is done (only codex needs one). Every
// provider also gets a per-user home directory on the data volume so CLI
// state never mixes between users — or with the server's own login.
export async function accountRuntime(db, account, opts = {}) {
  const dataDir = opts.dataDir || resolveLlmDataDir(opts.env || process.env);
  const sandbox = sandboxConfig(opts.env || process.env);
  const home = ensurePrivateDir(dataDir, account.provider, account.user_id, sandbox);
  // Under a sandbox the CLI runs as a uid that cannot write the server user's
  // $HOME, so point HOME at the per-user dir it can write. No effect otherwise.
  const homeEnv = sandbox ? { HOME: home } : {};

  if (account.provider === 'claude') {
    const env = { CLAUDE_CONFIG_DIR: home, ...homeEnv };
    if (account.kind === 'api_key') {
      env.ANTHROPIC_API_KEY = decryptSecrets(account.credentials, opts).api_key;
    } else if (account.kind === 'token') {
      env.CLAUDE_CODE_OAUTH_TOKEN = decryptSecrets(account.credentials, opts).token;
    } else {
      env.CLAUDE_CODE_OAUTH_TOKEN = await freshClaudeAccessToken(db, account, opts);
    }
    return { env, sync: null };
  }

  if (account.provider === 'codex') {
    if (account.kind === 'api_key') {
      return {
        env: {
          CODEX_HOME: home,
          ...homeEnv,
          OPENAI_API_KEY: decryptSecrets(account.credentials, opts).api_key,
        },
        sync: null,
      };
    }
    // auth_json: the file in CODEX_HOME is the live credential — codex
    // rotates the tokens in it as it runs. It is written from the database
    // only when missing (first run, or a rebuilt container), and read back
    // after each job so the database keeps up with the rotation.
    const file = path.join(home, 'auth.json');
    if (!fs.existsSync(file)) {
      const secrets = decryptSecrets(account.credentials, opts);
      fs.writeFileSync(file, JSON.stringify(secrets.auth, null, 2), { mode: 0o600 });
      // codex (running as the sandbox user) rotates this file in place, so it
      // needs group read/write when a sandbox is configured.
      prepareFileForSandbox(file, sandbox, { writable: true });
    }
    return {
      env: { CODEX_HOME: home, ...homeEnv },
      sync: async () => {
        let auth;
        try {
          auth = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch {
          return; // unreadable or gone; the stored copy stands
        }
        const stored = decryptSecrets(account.credentials, opts);
        if (JSON.stringify(stored.auth) === JSON.stringify(auth)) return;
        await account.update({ credentials: encryptSecrets({ auth }, opts) });
      },
    };
  }

  throw new Error(`Unknown LLM provider: ${account.provider}`);
}

// ---------------------------------------------------------------------------
// Quota pauses, per account
// ---------------------------------------------------------------------------

export async function pauseAccount(db, userId, provider, { until, reason = '' }) {
  const account = await getAccount(db, userId, provider);
  if (!account) return null;
  return account.update({
    paused_until: new Date(until),
    paused_reason: String(reason).slice(0, 300),
  });
}

export async function clearAccountPause(db, userId, provider) {
  const account = await getAccount(db, userId, provider);
  if (!account) return null;
  return account.update({ paused_until: null, paused_reason: '' });
}

// The users whose queued jobs should wait because their account is paused,
// and the pauses whose time has come (cleared here, reported so the worker
// can announce them). A pause only holds a user while the paused provider is
// still the one their jobs would run — a user who switched providers moved
// to a different subscription.
export async function sweepAccountPauses(db, now = Date.now()) {
  const paused = await db.models.UserLlmAccount.findAll({
    where: { paused_until: { [Op.ne]: null } },
  });
  const held = new Set();
  const resumed = [];
  if (paused.length === 0) return { held, resumed };

  const config = await getConfig(db);
  const users = new Map(
    (
      await db.models.User.findAll({ where: { id: paused.map((row) => row.user_id) } })
    ).map((user) => [user.id, user])
  );
  for (const row of paused) {
    if (new Date(row.paused_until).getTime() <= now) {
      await row.update({ paused_until: null, paused_reason: '' });
      resumed.push({ user_id: row.user_id, provider: row.provider });
      continue;
    }
    const user = users.get(row.user_id);
    const effective = user?.llm_provider || config.llm_provider;
    if (row.provider === effective) held.add(row.user_id);
  }
  return { held, resumed };
}

// ---------------------------------------------------------------------------
// Route guard
// ---------------------------------------------------------------------------

// Express guard for the routes that start LLM work: told at the door that no
// account is connected, rather than by a failed job later. Same shape as
// requireBudget (services/budgets.js).
export function requireLlmAccount(db) {
  return async (req, res, next) => {
    try {
      const settings = await getLlmSettings(db, null, req.user);
      const account = await getAccount(db, req.user.id, settings.provider);
      if (account) {
        req.llmAccount = account;
        return next();
      }
      res.status(409).json({
        error:
          `No ${settings.provider} account is connected. Authorize the app under ` +
          `Account → LLM provider before starting work that runs the model.`,
        code: 'llm_account_required',
        llm_provider: settings.provider,
      });
    } catch (e) {
      next(e);
    }
  };
}
