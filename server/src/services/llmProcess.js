// Running an agent CLI as a child process.
//
// Two things this file is responsible for and nothing else is: the child's
// environment is an ALLOWLIST rather than ours (the server's environment
// holds the database URL and the key that decrypts every user's provider
// credentials, and the agent runs untrusted text), and whatever the process
// printed is the error — both CLIs report no login, no quota, an unknown
// model and a refusal on STDOUT while exiting non-zero with nothing on
// stderr at all.

import { spawn } from 'node:child_process';
import { sandboxConfig, wrapForSandbox } from './sandbox.js';
import { detectQuotaExhaustion, noteQuotaExhaustion } from './llmQuota.js';

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
    // The child's environment is the allowlisted set only. When a sandbox user
    // is configured the command is rewritten to run as that user (via sudo),
    // and that environment is handed across explicitly (env -i) rather than
    // through spawn — so spawn itself gets only a bare PATH for sudo. Without a
    // sandbox, spawn carries the environment as before.
    const sandbox = sandboxConfig();
    const wanted = childEnv(env || {});
    const run = wrapForSandbox(cmd, args, wanted, sandbox);
    const child = spawn(run.cmd, run.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: sandbox ? { PATH: process.env.PATH } : wanted,
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
