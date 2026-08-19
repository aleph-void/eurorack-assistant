import { describe, it, expect } from 'vitest';
import { createTestDb, createUser, fakeBackend, insertModule } from './helpers.js';
import {
  describeComponentsForModule,
  undescribedComponents,
} from '../src/services/componentDescriber.js';
import { createHandlers } from '../src/jobs/handlers.js';

async function withComponents() {
  const db = await createTestDb();
  const user = await createUser(db, { username: 'alice' });
  const module = await insertModule(db, user.id, {
    manufacturer: 'Make Noise',
    name: 'Maths',
    summary: 'A dual function generator.',
    hp: 20,
  });
  const { rows } = await db.query(
    `INSERT INTO module_components (module_id, type, name, description) VALUES
     ($1, 'output_jack', 'EOR', 'End of rise gate.'),
     ($1, 'output_jack', 'Both', NULL),
     ($1, 'input_jack', 'Trig', '   '),
     ($1, 'knob', 'Rise', '') RETURNING *`,
    [module.id]
  );
  return { db, user, module, components: rows };
}

describe('describeComponentsForModule', () => {
  it('asks only about blank components and writes only their descriptions', async () => {
    const { db, module } = await withComponents();
    expect((await undescribedComponents(db, module.id)).map((c) => c.name)).toEqual([
      'Both',
      'Trig',
      'Rise',
    ]);

    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        components: [
          { name: 'both', description: '  A logical OR of the two channels.  ' },
          { name: 'Rise', description: 'Sets the rise time.' },
          // Components it was not asked about are ignored, described or not.
          { name: 'EOR', description: 'Something else entirely.' },
          { name: 'Trig', description: '' },
        ],
      }),
    });
    const result = await describeComponentsForModule(db, backend, module, '/tmp/manual.pdf');
    expect(result).toEqual({ asked: 3, described: 2, summary: false, hp: false });

    // The prompt names exactly the blank components, and asks for neither a
    // summary nor a width — the module already has both.
    const [prompt, path] = backend.calls.analyzeDocument[0];
    expect(path).toBe('/tmp/manual.pdf');
    expect(prompt).toContain('"Both" (output jack)');
    expect(prompt).toContain('"Rise" (knob)');
    expect(prompt).not.toContain('"EOR"');
    expect(prompt).not.toContain('summary of what the module');
    expect(prompt).not.toContain('how wide');

    const { rows } = await db.query(
      'SELECT name, description FROM module_components WHERE module_id = $1 ORDER BY id',
      [module.id]
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.description]))).toEqual({
      // An existing description is never overwritten, whatever the model says.
      EOR: 'End of rise gate.',
      Both: 'A logical OR of the two channels.',
      // The model skipped it, so it stays blank rather than being invented.
      Trig: '   ',
      Rise: 'Sets the rise time.',
    });
  });

  it('runs no model at all when every component is described', async () => {
    const { db, module } = await withComponents();
    await db.query('UPDATE module_components SET description = $1 WHERE module_id = $2', [
      'Filled.',
      module.id,
    ]);
    const backend = fakeBackend({});
    expect(await describeComponentsForModule(db, backend, module, '/x.pdf')).toEqual({
      asked: 0,
      described: 0,
      summary: false,
      hp: false,
    });
    expect(backend.calls.analyzeDocument).toHaveLength(0);
  });

  it('fills a blank summary and a missing width, and only into blanks', async () => {
    const { db, user } = await withComponents();
    const bare = await insertModule(db, user.id, { manufacturer: '2hp', name: 'Pluck' });
    await db.query(
      `INSERT INTO module_components (module_id, type, name, description)
       VALUES ($1, 'output_jack', 'OUT', 'The voice output.')`,
      [bare.id]
    );
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: '  A plucked-string voice.  ',
        hp: '2',
        components: [],
      }),
    });
    const result = await describeComponentsForModule(db, backend, bare, '/m.pdf');
    expect(result).toEqual({ asked: 0, described: 0, summary: true, hp: true });
    const [prompt] = backend.calls.analyzeDocument[0];
    expect(prompt).toContain('summary of what the module');
    expect(prompt).toContain('how wide');

    const after = await db.models.Module.findByPk(bare.id);
    expect(after.summary).toBe('A plucked-string voice.');
    expect(after.hp).toBe(2);

    // Run again with a different answer: everything is filled, nothing to
    // ask, nothing overwritten.
    const noisy = fakeBackend({
      analyzeDocument: JSON.stringify({ summary: 'Wrong.', hp: 8, components: [] }),
    });
    expect(await describeComponentsForModule(db, noisy, bare, '/m.pdf')).toEqual({
      asked: 0,
      described: 0,
      summary: false,
      hp: false,
    });
    expect(noisy.calls.analyzeDocument).toHaveLength(0);
    expect((await db.models.Module.findByPk(bare.id)).summary).toBe('A plucked-string voice.');
  });

  it('ignores a width the model made up badly', async () => {
    const { db, user } = await withComponents();
    const bare = await insertModule(db, user.id, {
      manufacturer: '2hp',
      name: 'Verb',
      summary: 'A reverb.',
    });
    await db.query(
      `INSERT INTO module_components (module_id, type, name, description)
       VALUES ($1, 'output_jack', 'OUT', 'Out.')`,
      [bare.id]
    );
    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({ hp: 'very wide', components: [] }),
    });
    expect(await describeComponentsForModule(db, backend, bare, '/m.pdf')).toEqual({
      asked: 0,
      described: 0,
      summary: false,
      hp: false,
    });
    expect((await db.models.Module.findByPk(bare.id)).hp).toBeNull();
  });

  it('submits several documents together', async () => {
    const { db, module } = await withComponents();
    const backend = fakeBackend({
      analyzeDocuments: JSON.stringify({ components: [] }),
    });
    await describeComponentsForModule(db, backend, module, ['/a.pdf', '/b.pdf']);
    expect(backend.calls.analyzeDocuments).toHaveLength(1);
    expect(backend.calls.analyzeDocuments[0][1]).toEqual(['/a.pdf', '/b.pdf']);
  });

  it('is wired up as the describe_components job', async () => {
    const { db } = await withComponents();
    const handlers = createHandlers(db, { manualsDir: '/tmp' });
    expect(Object.keys(handlers)).toContain('describe_components');
  });
});
