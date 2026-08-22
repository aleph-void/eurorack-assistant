// The document jail.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxConfig,
  prepareDirForSandbox,
  prepareFileForSandbox,
} from './sandbox.js';
// The document jail
//
// Every file an agent is allowed to read is copied into a directory made for
// that one call, and that directory is the only one it is given.
//
// The alternative — pointing the agent at the file where it already lives —
// hands it the whole directory, because that is the unit permission comes in.
// Manuals and captures are content-addressed into one flat directory each, so
// "let it read this PDF" and "let it read every PDF in the app" were the same
// sentence: a question of one user's could reach another user's private
// upload, or their oscilloscope captures, simply by looking. Nothing in the
// prompt invited that, and nothing in the prompt prevented it either.
//
// A hard link where the filesystem allows one, a copy where it does not (the
// data volume and /tmp are usually different devices). Names are kept because
// the model reads them — a file called Maths_manual.md says what it is — and
// only deduplicated when two documents would collide.
export function stageDocuments(paths = [], { tmpdir = os.tmpdir } = {}) {
  const sandbox = sandboxConfig();
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'llm-docs-'));
  // Let the sandbox user into the jail (setgid so the copies below inherit the
  // shared group). Done before staging so the group is in place on create.
  prepareDirForSandbox(dir, sandbox);
  const taken = new Set();
  const staged = [];
  for (const source of paths.map((p) => path.resolve(p))) {
    let name = path.basename(source);
    if (taken.has(name)) {
      for (let n = 2; taken.has(name); n += 1) name = `${n}-${path.basename(source)}`;
    }
    taken.add(name);
    const target = path.join(dir, name);
    try {
      // A hard link keeps the source's owner and mode, which the sandbox user
      // may not be able to read; under a sandbox always copy, so the file is
      // created fresh in the setgid jail and its group/mode can be set.
      if (sandbox) throw new Error('copy under sandbox');
      fs.linkSync(source, target);
    } catch {
      // Cross-device (the data volume and /tmp usually are), or a filesystem
      // with no links. A document that cannot be staged at all is a job that
      // fails rather than one that quietly answers without it.
      try {
        fs.copyFileSync(source, target);
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`could not give the model ${source}: ${e.message}`, { cause: e });
      }
    }
    prepareFileForSandbox(target, sandbox);
    staged.push(target);
  }
  return {
    dir,
    paths: staged,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
