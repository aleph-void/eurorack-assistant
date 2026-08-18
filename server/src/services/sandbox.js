// Running the agent CLIs (`claude`, `codex`) as a separate, unprivileged OS
// user.
//
// Why: an agent runs untrusted text (a user's question, a manual's contents)
// and, for codex, its read-only sandbox is "read-only" about *writing* — it can
// still open any file the process can. Run as the same uid as the server and
// that includes /data/keys (the master key that decrypts every stored
// credential), the database socket, and the app source. Running it as a
// distinct uid that owns none of those closes that reach: the file system
// itself refuses the read.
//
// How: the server runs unprivileged (as `node`), so it cannot change the
// child's uid directly — spawn's uid option needs privilege we deliberately do
// not have. Instead the child is launched through `sudo -u <user>`, which the
// image grants `node` for exactly this (a NOPASSWD rule, see the Dockerfile).
// The clean, allowlisted environment is handed across explicitly with `env -i`
// because sudo scrubs the environment — which is a feature here, not an
// obstacle: it guarantees the child starts from nothing but what we name.
//
// The whole thing is behind LLM_SANDBOX_USER. Unset (development, the test
// suite, an existing single-tenant deployment) means "run in-process as now",
// so nothing here changes behaviour until the image opts in.

import fs from 'node:fs';

// { user, gid } when a sandbox user is configured, otherwise null. gid is the
// shared group (LLM_SANDBOX_GID) that both `node` and the sandbox user belong
// to, used to hand working directories and staged files across the uid
// boundary; null gid means "do not adjust group ownership".
export function sandboxConfig(env = process.env) {
  const user = String(env.LLM_SANDBOX_USER || '').trim();
  if (!user) return null;
  const gidRaw = String(env.LLM_SANDBOX_GID || '').trim();
  const gid = /^\d+$/.test(gidRaw) ? Number(gidRaw) : null;
  return { user, gid };
}

// Rewrite (cmd, args) so the command runs as the sandbox user with exactly
// `envObj` as its environment. Passthrough when no sandbox is configured.
export function wrapForSandbox(cmd, args, envObj, config = sandboxConfig()) {
  if (!config) return { cmd, args };
  const envPairs = Object.entries(envObj).map(([k, v]) => `${k}=${v}`);
  return {
    cmd: 'sudo',
    // -n: never prompt (fail instead). env -i: empty environment, then only
    // the pairs we pass — the child inherits nothing from the server process.
    args: ['-n', '-u', config.user, '--', '/usr/bin/env', '-i', ...envPairs, cmd, ...args],
  };
}

// A directory the sandbox user must be able to enter and write (a document
// jail, the codex output dir, a per-user credential home). Hands it across the
// uid boundary via the shared group with the setgid bit, so files created
// inside inherit the group too. `node` can chgrp to a group it is a member of.
// No-op without a sandbox, so callers can prepare unconditionally.
export function prepareDirForSandbox(dir, config = sandboxConfig()) {
  if (!config) return;
  try {
    if (config.gid !== null) fs.chownSync(dir, -1, config.gid);
    fs.chmodSync(dir, 0o2770);
  } catch {
    // Best effort: a deployment whose group/ownership is not what this expects
    // should fail loudly at the CLI, not here — the run will simply be denied.
  }
}

// A single file the sandbox user must be able to read (a staged document) or
// read and rewrite (the codex auth.json it rotates). Group read/write via the
// shared group; the setgid parent already set the group on create, but a hard
// link keeps its original group so the chown is repeated here to be safe.
export function prepareFileForSandbox(file, config = sandboxConfig(), { writable = false } = {}) {
  if (!config) return;
  try {
    if (config.gid !== null) fs.chownSync(file, -1, config.gid);
    fs.chmodSync(file, writable ? 0o660 : 0o640);
  } catch {
    /* best effort — see prepareDirForSandbox */
  }
}
