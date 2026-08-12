import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTestDb,
  createUser,
  insertModule,
  fakeBackend,
  fakeFetch,
  PDF_BYTES,
  PDF_HASH,
} from './helpers.js';
import { findManualForModule, researchModule } from '../src/services/manualFinder.js';
import {
  analyzeManualForModule,
  normalizeComponents,
  ANALYSIS_TEMPLATE,
} from '../src/services/manualAnalyzer.js';
import {
  determineScope,
  determineComponentScope,
  jackComponentsForModules,
  answerQuestion,
  findPreviousAnswers,
} from '../src/services/ask.js';
import { getConfig, setConfig, getLlmSettings } from '../src/services/config.js';

let manualsDir;
beforeEach(() => {
  manualsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manuals-'));
});
afterEach(() => {
  fs.rmSync(manualsDir, { recursive: true, force: true });
});

describe('config service', () => {
  it('returns defaults and persists updates', async () => {
    const db = await createTestDb();
    expect(await getConfig(db)).toEqual({ llm_provider: 'claude', llm_model: '' });
    await setConfig(db, { llm_provider: 'codex', llm_model: 'gpt-5.1' });
    expect(await getConfig(db)).toEqual({ llm_provider: 'codex', llm_model: 'gpt-5.1' });
    await setConfig(db, { llm_model: '' });
    expect((await getLlmSettings(db)).model).toBe('gpt-5.1-codex');
  });

  it('rejects unknown keys and bad providers', async () => {
    const db = await createTestDb();
    await expect(setConfig(db, { hacker: '1' })).rejects.toThrow(/Unknown config key/);
    await expect(setConfig(db, { llm_provider: 'openai-api' })).rejects.toThrow(
      /Invalid llm_provider/
    );
  });

  it('falls back to the provider default model', async () => {
    const db = await createTestDb();
    const settings = await getLlmSettings(db);
    expect(settings).toEqual({ provider: 'claude', model: 'claude-fable-5' });
  });
});

describe('researchModule', () => {
  it('parses and normalizes the LLM research response', async () => {
    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: 'https://makenoise.com/maths.pdf',
        product_page_url: null,
      }),
    });
    const info = await researchModule(backend, 'Make Noise,Maths');
    expect(info.pdf_urls).toEqual(['https://makenoise.com/maths.pdf']);
    expect(backend.calls.completeTextWithSearch[0][0]).toContain('Make Noise,Maths');
  });

  it('throws when manufacturer/module are missing', async () => {
    const backend = fakeBackend({ completeTextWithSearch: '{"pdf_urls": []}' });
    await expect(researchModule(backend, 'mystery')).rejects.toThrow(/missing manufacturer/);
  });
});

describe('findManualForModule', () => {
  it('downloads the researched PDF and marks the module found', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: 'https://makenoise.com/maths',
      }),
    });
    const fetchImpl = fakeFetch({ 'makenoise.com/maths.pdf': { body: PDF_BYTES } });

    const hash = await findManualForModule(db, backend, module, manualsDir, { fetchImpl });
    expect(hash).toBe(PDF_HASH);
    // Stored content-addressed: the file lives at <hash>.pdf.
    expect(fs.existsSync(path.join(manualsDir, `${hash}.pdf`))).toBe(true);

    const { rows } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(rows[0].manual_status).toBe('found');

    // Recorded as the shared (user_id NULL) manual document.
    const { rows: manualRows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [
      module.id,
    ]);
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0]).toMatchObject({
      hash,
      user_id: null,
      name: 'manual',
      original_name: 'Make_Noise_Maths_Manual.pdf',
      source: 'found',
    });
  });

  it('re-running references the existing document instead of duplicating it', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: null,
      }),
    });
    const fetchImpl = fakeFetch({ 'makenoise.com/maths.pdf': { body: PDF_BYTES } });

    await findManualForModule(db, backend, module, manualsDir, { fetchImpl });
    await findManualForModule(db, backend, module, manualsDir, { fetchImpl });

    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows).toHaveLength(1);
    expect(fs.readdirSync(manualsDir)).toEqual([`${PDF_HASH}.pdf`]);
  });

  it('falls back to archive.org when direct downloads fail', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://dead.example.com/maths.pdf'],
        product_page_url: null,
      }),
    });
    const fetchImpl = fakeFetch({
      'dead.example.com': { status: 404 },
      'archive.org/advancedsearch.php': { json: { response: { docs: [{ identifier: 'maths-manual' }] } } },
      'archive.org/metadata/maths-manual': { json: { files: [{ name: 'maths.pdf' }] } },
      'archive.org/download/maths-manual': { body: PDF_BYTES },
    });

    const hash = await findManualForModule(db, backend, module, manualsDir, { fetchImpl });
    expect(hash).toBe(PDF_HASH);
  });

  it('marks the module failed when nothing is found', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: [],
        product_page_url: null,
      }),
    });
    const fetchImpl = fakeFetch({ 'archive.org/advancedsearch.php': { json: { response: { docs: [] } } } });

    const name = await findManualForModule(db, backend, module, manualsDir, { fetchImpl });
    expect(name).toBeNull();
    const { rows } = await db.query('SELECT manual_status FROM modules WHERE id = $1', [module.id]);
    expect(rows[0].manual_status).toBe('failed');
  });

  it('adopts researched naming for free-text imports', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manufacturer: '', name: 'make noise maths' });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: null,
      }),
    });
    const fetchImpl = fakeFetch({ 'makenoise.com': { body: PDF_BYTES } });

    await findManualForModule(db, backend, module, manualsDir, { fetchImpl });
    const { rows } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(rows[0].manufacturer).toBe('Make Noise');
    expect(rows[0].name).toBe('Maths');
  });

  it('keeps the free-text naming when the researched name collides with another module', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    await insertModule(db, user.id, { manufacturer: 'Make Noise', name: 'Maths' });
    const freeText = await insertModule(db, user.id, {
      manufacturer: '',
      name: 'maths by make noise',
    });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://makenoise.com/maths.pdf'],
        product_page_url: null,
      }),
    });
    const fetchImpl = fakeFetch({ 'makenoise.com': { body: PDF_BYTES } });

    await findManualForModule(db, backend, freeText, manualsDir, { fetchImpl });
    const { rows } = await db.query('SELECT * FROM modules WHERE id = $1', [freeText.id]);
    expect(rows[0].name).toBe('maths by make noise');
    const { rows: all } = await db.query('SELECT * FROM modules');
    expect(all).toHaveLength(2);
  });
});

describe('normalizeComponents', () => {
  it('normalizes types, polarity, and voltages', () => {
    const components = normalizeComponents([
      { type: 'Input Jack', name: '1V/OCT', voltage_min: '-2', voltage_max: 5, polarity: 'Bipolar' },
      { type: 'weird', name: 'Screen', polarity: 'no' },
      { type: 'knob', name: '' },
      null,
    ]);
    expect(components).toEqual([
      {
        type: 'input_jack',
        name: '1V/OCT',
        description: null,
        voltage_min: -2,
        voltage_max: 5,
        polarity: 'bipolar',
      },
      {
        type: 'other',
        name: 'Screen',
        description: null,
        voltage_min: null,
        voltage_max: null,
        polarity: null,
      },
    ]);
  });
});

describe('analyzeManualForModule', () => {
  it('stores the summary and typed components', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });

    const backend = fakeBackend({
      analyzeDocument: JSON.stringify({
        summary: 'Maths is a dual function generator.',
        components: [
          {
            type: 'input_jack',
            name: 'Signal In 1',
            description: 'Signal input for channel 1',
            voltage_min: -10,
            voltage_max: 10,
            polarity: 'bipolar',
          },
          {
            type: 'output_jack',
            name: 'EOR',
            description: 'End of rise gate output',
            voltage_min: 0,
            voltage_max: 10,
            polarity: 'unipolar',
          },
          { type: 'button', name: 'Cycle', description: 'Toggles cycling' },
        ],
      }),
    });

    const result = await analyzeManualForModule(db, backend, module, '/tmp/maths.pdf');
    expect(result.components).toHaveLength(3);
    expect(backend.calls.analyzeDocument[0][0]).toContain('Make Noise Maths');

    const { rows: stored } = await db.query(
      'SELECT * FROM module_components WHERE module_id = $1 ORDER BY id',
      [module.id]
    );
    expect(stored).toHaveLength(3);
    expect(stored[0].type).toBe('input_jack');
    expect(stored[1].polarity).toBe('unipolar');
    expect(stored[2].voltage_min).toBeNull();

    const { rows: mod } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(mod[0].analysis_status).toBe('complete');
    expect(mod[0].summary).toContain('dual function generator');
  });

  it('replaces components on re-analysis', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH });
    await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'other', 'Stale')`,
      [module.id]
    );

    const backend = fakeBackend({
      analyzeDocument: '{"summary": "New", "components": [{"type": "knob", "name": "Rise"}]}',
    });
    await analyzeManualForModule(db, backend, module, '/tmp/m.pdf');
    const { rows } = await db.query('SELECT name FROM module_components WHERE module_id = $1', [
      module.id,
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Rise']);
  });

  it('rejects an empty analysis', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH });
    const backend = fakeBackend({ analyzeDocument: '{"summary": "", "components": []}' });
    await expect(analyzeManualForModule(db, backend, module, '/tmp/m.pdf')).rejects.toThrow(
      /neither a summary nor components/
    );
  });

  it('asks for every component type in the prompt', () => {
    const prompt = ANALYSIS_TEMPLATE('Make Noise', 'Maths');
    for (const term of ['input_jack', 'output_jack', 'button', 'toggle', 'unipolar', 'bipolar']) {
      expect(prompt).toContain(term);
    }
  });
});

describe('determineScope', () => {
  const modules = [
    { id: 1, manufacturer: 'Make Noise', name: 'Maths' },
    { id: 2, manufacturer: 'Mutable Instruments', name: 'Beads' },
  ];

  it('matches scoped modules case-insensitively and dedupes', async () => {
    const backend = fakeBackend({
      completeText:
        '[{"manufacturer": "MAKE NOISE", "module": "maths"}, {"manufacturer": "Make Noise", "module": "Maths"}]',
    });
    const scoped = await determineScope(backend, 'How does Maths work?', modules);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe(1);
  });

  it('ignores hallucinated modules', async () => {
    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Imaginary", "module": "Ghost"}]',
    });
    expect(await determineScope(backend, 'q', modules)).toHaveLength(0);
  });

  it('includes the module list in the prompt', async () => {
    const backend = fakeBackend({ completeText: '[]' });
    await determineScope(backend, 'q', modules);
    expect(backend.calls.completeText[0][0]).toContain('Make Noise,Maths');
    expect(backend.calls.completeText[0][0]).toContain('Mutable Instruments,Beads');
  });
});

describe('determineComponentScope', () => {
  const jacks = [
    { id: 1, name: 'Signal In', type: 'input_jack', module_label: 'Make Noise Maths' },
    { id: 2, name: 'EOR', type: 'output_jack', module_label: 'Make Noise Maths' },
    { id: 3, name: 'Out L', type: 'output_jack', module_label: 'Mutable Instruments Beads' },
  ];

  it('returns [] without calling the LLM when there are no jacks', async () => {
    const backend = fakeBackend();
    expect(await determineComponentScope(backend, 'q', [])).toEqual([]);
    expect(backend.calls.completeText).toHaveLength(0);
  });

  it('matches selected jack ids across multiple modules', async () => {
    const backend = fakeBackend({ completeText: '[2, 3]' });
    const scoped = await determineComponentScope(backend, 'Patch EOR into Beads?', jacks);
    expect(scoped.map((c) => c.id)).toEqual([2, 3]);
    const prompt = backend.calls.completeText[0][0];
    expect(prompt).toContain('2 | Make Noise Maths | EOR | output_jack');
  });

  it('tolerates object entries and ignores unknown/duplicate ids', async () => {
    const backend = fakeBackend({ completeText: '[{"id": 1}, 1, 99]' });
    const scoped = await determineComponentScope(backend, 'q', jacks);
    expect(scoped.map((c) => c.id)).toEqual([1]);
  });
});

describe('jackComponentsForModules', () => {
  it('returns only jack components with module labels', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);
    await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'input_jack', 'Signal In'), ($1, 'knob', 'Rise'), ($1, 'output_jack', 'EOR')`,
      [module.id]
    );
    const jacks = await jackComponentsForModules(db, [module.id]);
    expect(jacks.map((j) => j.name)).toEqual(['Signal In', 'EOR']);
    expect(jacks[0].module_label).toBe('Make Noise Maths');
    expect(await jackComponentsForModules(db, [])).toEqual([]);
  });
});

describe('answerQuestion', () => {
  async function fixture() {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    const { rows } = await db.query(
      `INSERT INTO questions (user_id, prompt) VALUES ($1, 'How do I patch a krell?') RETURNING *`,
      [user.id]
    );
    return { db, user, module, question: rows[0] };
  }

  it('scopes, links modules, answers with manuals, and saves', async () => {
    const { db, module, question } = await fixture();
    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Make Noise", "module": "Maths"}]',
      answerWithDocuments: 'Patch it like this...',
    });

    const updated = await answerQuestion(db, backend, question, manualsDir);
    expect(updated.status).toBe('answered');
    expect(updated.answer).toBe('Patch it like this...');
    expect(updated.answered_at).toBeTruthy();

    const { rows: links } = await db.query(
      'SELECT * FROM question_modules WHERE question_id = $1',
      [question.id]
    );
    expect(links).toHaveLength(1);
    expect(links[0].module_id).toBe(module.id);

    const [prompt, pdfs] = backend.calls.answerWithDocuments[0];
    expect(prompt).toContain('How do I patch a krell?');
    expect(prompt).toContain('Make Noise Maths');
    expect(pdfs).toEqual([path.join(manualsDir, `${PDF_HASH}.pdf`)]);
  });

  it('links the specific jacks a question pertains to', async () => {
    const { db, module, question } = await fixture();
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
       ($1, 'input_jack', 'Signal In'), ($1, 'output_jack', 'EOR') RETURNING id`,
      [module.id]
    );

    let call = 0;
    const backend = fakeBackend({
      completeText: () => {
        call += 1;
        // First completeText call scopes modules, second scopes jacks.
        return call === 1
          ? '[{"manufacturer": "Make Noise", "module": "Maths"}]'
          : `[${jacks[1].id}]`;
      },
      answerWithDocuments: 'Use the EOR output.',
    });

    await answerQuestion(db, backend, question, manualsDir);
    const { rows: links } = await db.query(
      'SELECT component_id FROM question_components WHERE question_id = $1',
      [question.id]
    );
    expect(links.map((l) => l.component_id)).toEqual([jacks[1].id]);
  });

  it('still answers when component scoping fails', async () => {
    const { db, module, question } = await fixture();
    await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'input_jack', 'In')`,
      [module.id]
    );
    let call = 0;
    const backend = fakeBackend({
      completeText: () => {
        call += 1;
        if (call === 1) return '[{"manufacturer": "Make Noise", "module": "Maths"}]';
        throw new Error('component scoping exploded');
      },
      answerWithDocuments: 'Answer anyway.',
    });
    const updated = await answerQuestion(db, backend, question, manualsDir);
    expect(updated.status).toBe('answered');
    const { rows: links } = await db.query('SELECT * FROM question_components');
    expect(links).toHaveLength(0);
  });

  it('feeds previous answers about in-scope modules as context', async () => {
    const { db, user, module, question } = await fixture();
    const { rows: prev } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'Earlier question', 'Earlier answer', 'answered', now()) RETURNING *`,
      [user.id]
    );
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      prev[0].id,
      module.id,
    ]);

    const docs = await findPreviousAnswers(db, user.id, [module.id]);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toContain('Earlier answer');

    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Make Noise", "module": "Maths"}]',
      answerWithDocuments: 'ok',
    });
    await answerQuestion(db, backend, question, manualsDir);
    const [, , textDocs] = backend.calls.answerWithDocuments[0];
    expect(textDocs).toHaveLength(1);
    expect(textDocs[0].text).toContain('Earlier question');
  });

  it('fails when nothing is in scope', async () => {
    const { db, question } = await fixture();
    const backend = fakeBackend({ completeText: '[]' });
    await expect(answerQuestion(db, backend, question, manualsDir)).rejects.toThrow(/in scope/);
  });

  it('fails when no manuals or previous answers exist', async () => {
    const { db, question } = await fixture();
    await db.query('DELETE FROM manuals');
    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Make Noise", "module": "Maths"}]',
    });
    await expect(answerQuestion(db, backend, question, manualsDir)).rejects.toThrow(
      /No valid manual PDFs/
    );
  });

  it("attaches the user's own uploaded documents but not other users'", async () => {
    const { db, user, module, question } = await fixture();
    const other = await createUser(db, { username: 'other' });
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const myHash = sha(Buffer.concat([PDF_BYTES, Buffer.from('mine')]));
    const theirHash = sha(Buffer.concat([PDF_BYTES, Buffer.from('theirs')]));
    fs.writeFileSync(path.join(manualsDir, `${myHash}.pdf`), PDF_BYTES);
    fs.writeFileSync(path.join(manualsDir, `${theirHash}.pdf`), PDF_BYTES);
    await db.query(
      `INSERT INTO manuals (module_id, user_id, hash, name, source) VALUES
       ($1, $2, '${myHash}', 'my notes', 'upload'), ($1, $3, '${theirHash}', 'their notes', 'upload')`,
      [module.id, user.id, other.id]
    );

    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Make Noise", "module": "Maths"}]',
      answerWithDocuments: 'ok',
    });
    await answerQuestion(db, backend, question, manualsDir);
    const [, pdfs] = backend.calls.answerWithDocuments[0];
    const names = pdfs.map((p) => path.basename(p));
    expect(names).toContain(`${PDF_HASH}.pdf`);
    expect(names).toContain(`${myHash}.pdf`);
    expect(names).not.toContain(`${theirHash}.pdf`);
  });
});
