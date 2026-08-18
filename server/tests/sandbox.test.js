// The separate-uid sandbox: how a run is rewritten to execute as another user,
// and that it all collapses to a no-op when no sandbox user is configured.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  sandboxConfig,
  wrapForSandbox,
  prepareDirForSandbox,
  prepareFileForSandbox,
} from '../src/services/sandbox.js';

describe('sandboxConfig', () => {
  it('is null when no sandbox user is set', () => {
    expect(sandboxConfig({})).toBeNull();
    expect(sandboxConfig({ LLM_SANDBOX_USER: '' })).toBeNull();
  });
  it('reads the user and numeric gid', () => {
    expect(sandboxConfig({ LLM_SANDBOX_USER: 'agent', LLM_SANDBOX_GID: '2000' })).toEqual({
      user: 'agent',
      gid: 2000,
    });
  });
  it('leaves gid null when it is missing or not numeric', () => {
    expect(sandboxConfig({ LLM_SANDBOX_USER: 'agent' }).gid).toBeNull();
    expect(sandboxConfig({ LLM_SANDBOX_USER: 'agent', LLM_SANDBOX_GID: 'x' }).gid).toBeNull();
  });
});

describe('wrapForSandbox', () => {
  it('passes the command through unchanged with no sandbox', () => {
    const out = wrapForSandbox('codex', ['exec', '-m', 'gpt-5'], { PATH: '/usr/bin' }, null);
    expect(out).toEqual({ cmd: 'codex', args: ['exec', '-m', 'gpt-5'] });
  });
  it('runs the command as the sandbox user with an explicit, isolated env', () => {
    const out = wrapForSandbox(
      'codex',
      ['exec'],
      { PATH: '/usr/bin', CODEX_HOME: '/data/llm/codex/3' },
      { user: 'agent', gid: 2000 }
    );
    expect(out.cmd).toBe('sudo');
    expect(out.args).toEqual([
      '-n',
      '-u',
      'agent',
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=/usr/bin',
      'CODEX_HOME=/data/llm/codex/3',
      'codex',
      'exec',
    ]);
  });
});

describe('prepare helpers', () => {
  it('do nothing without a sandbox (dir/file modes are left as created)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x', { mode: 0o600 });
    prepareDirForSandbox(dir, null);
    prepareFileForSandbox(file, null);
    // 0700 dir, 0600 file — unchanged.
    expect(fs.statSync(dir).mode & 0o777).toBe(fs.statSync(dir).mode & 0o777);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
