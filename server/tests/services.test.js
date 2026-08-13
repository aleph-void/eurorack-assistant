import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTestDb,
  createUser,
  insertManualText,
  insertModule,
  fakeBackend,
  fakeFetch,
  PDF_BYTES,
  PDF_HASH,
  TRUNCATED_PDF_BYTES,
} from './helpers.js';

// A second content hash, for the module whose manual has not been extracted.
const OTHER_HASH = crypto.createHash('sha256').update('another manual').digest('hex');
import { findManualForModule, researchModule } from '../src/services/manualFinder.js';
import {
  analyzeManualForModule,
  normalizeComponents,
  normalizeNormalizations,
  resolveNormalizations,
  ANALYSIS_TEMPLATE,
} from '../src/services/manualAnalyzer.js';
import {
  determineScope,
  determineComponentScope,
  jackComponentsForModules,
  answerQuestion,
  scopeQuestion,
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
    const perTypeDefaults = {
      llm_model_find_manual: '',
      llm_model_analyze_manual: '',
      llm_model_extract_manual: '',
      llm_model_panel_image: '',
      llm_model_scope_question: '',
      llm_model_answer_question: '',
    };
    // The queue pause lives in app_config too; blank means the queue runs.
    const queueDefaults = { queue_paused_until: '', queue_paused_reason: '' };
    expect(await getConfig(db)).toEqual({
      llm_provider: 'claude',
      llm_model: '',
      import_workers: '4',
      ...perTypeDefaults,
      ...queueDefaults,
    });
    await setConfig(db, { llm_provider: 'codex', llm_model: 'gpt-5.1' });
    expect(await getConfig(db)).toEqual({
      llm_provider: 'codex',
      llm_model: 'gpt-5.1',
      import_workers: '4',
      ...perTypeDefaults,
      ...queueDefaults,
    });
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

  it('resolves per-job-type model overrides', async () => {
    const db = await createTestDb();
    await setConfig(db, { llm_model_find_manual: 'claude-haiku-4-5' });
    expect((await getLlmSettings(db, 'find_manual')).model).toBe('claude-haiku-4-5');
    // Other types fall back to the global model, then the provider default.
    expect((await getLlmSettings(db, 'analyze_manual')).model).toBe('claude-fable-5');
    await setConfig(db, { llm_model: 'claude-sonnet-5' });
    expect((await getLlmSettings(db, 'analyze_manual')).model).toBe('claude-sonnet-5');
    expect((await getLlmSettings(db, 'find_manual')).model).toBe('claude-haiku-4-5');
    // Non-LLM job types (import, export_rack) have no override key.
    expect((await getLlmSettings(db, 'import')).model).toBe('claude-sonnet-5');
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

describe('transactions', () => {
  // Multi-table writes run inside sequelize.transaction. pg-mem parses
  // BEGIN/COMMIT/ROLLBACK but auto-commits every statement (rollback is a
  // no-op), so real atomicity is only exercised against actual PostgreSQL —
  // this just pins down that the transaction plumbing (dedicated connection,
  // { transaction } threading, error propagation) works against the test db.
  it('commits writes and propagates errors through sequelize.transaction', async () => {
    const db = await createTestDb();
    await db.sequelize.transaction(async (transaction) => {
      await db.models.Module.create(
        { manufacturer: 'Make Noise', name: 'Maths' },
        { transaction }
      );
    });
    const { rows } = await db.query('SELECT * FROM modules');
    expect(rows).toHaveLength(1);

    await expect(
      db.sequelize.transaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
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

  // Render stub: url-substring -> PDF bytes to "render"; unmatched urls fail.
  function fakeRender(routes) {
    const calls = [];
    const impl = async (url, dest) => {
      calls.push(String(url));
      const match = Object.keys(routes).find((k) => String(url).includes(k));
      if (!match) return false;
      fs.writeFileSync(dest, routes[match]);
      return true;
    };
    impl.calls = calls;
    return impl;
  }

  const RENDER_A = Buffer.from('%PDF-1.4 product page render A');
  const RENDER_A_HASH = crypto.createHash('sha256').update(RENDER_A).digest('hex');
  const RENDER_B = Buffer.from('%PDF-1.4 product page render B');
  const RENDER_B_HASH = crypto.createHash('sha256').update(RENDER_B).digest('hex');

  it('renders the product page when no PDF manual can be downloaded', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: ['https://dead.example.com/maths.pdf'],
        product_page_url: 'https://makenoise.com/maths',
      }),
    });
    const fetchImpl = fakeFetch({
      'dead.example.com': { status: 404 },
      // No archived copy of the dead manual URL either.
      'archive.org/wayback/available': { json: {} },
    });
    const renderImpl = fakeRender({ 'makenoise.com/maths': RENDER_A });

    const hash = await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      renderImpl,
    });
    expect(hash).toBe(RENDER_A_HASH);
    expect(renderImpl.calls).toEqual(['https://makenoise.com/maths']);
    // The render satisfied the job, so the archive.org item library was
    // never consulted.
    expect(fetchImpl.requested.some((u) => u.includes('advancedsearch'))).toBe(false);

    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].original_name).toBe('Make_Noise_Maths_Product_Page.pdf');
    expect(fs.existsSync(path.join(manualsDir, `${hash}.pdf`))).toBe(true);
  });

  it('renders the product page when the manual URL serves a corrupt PDF', async () => {
    // erogenous-tones.com/download/vc8-instructions.pdf answers 200 with
    // application/pdf, but the body is cut short: the %PDF- header survives
    // while the xref table and trailer do not, so nothing downstream can read
    // it. It must not be stored as the module's manual.
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manufacturer: 'Erogenous Tones', name: 'VC8' });

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Erogenous Tones',
        module: 'VC8',
        pdf_urls: ['https://erogenous-tones.com/download/vc8-instructions.pdf'],
        product_page_url: 'https://erogenous-tones.com/erogenous-tones-vc8.html',
      }),
    });
    const fetchImpl = fakeFetch({
      'erogenous-tones.com/download': { body: TRUNCATED_PDF_BYTES },
      // No archived copy of the truncated manual either.
      'archive.org/wayback/available': { json: {} },
    });
    const renderImpl = fakeRender({ 'erogenous-tones-vc8.html': RENDER_A });

    const hash = await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      renderImpl,
    });
    expect(hash).toBe(RENDER_A_HASH);
    expect(renderImpl.calls).toEqual(['https://erogenous-tones.com/erogenous-tones-vc8.html']);

    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].original_name).toBe('Erogenous_Tones_VC8_Product_Page.pdf');
    // The truncated download left nothing behind.
    expect(fs.readdirSync(manualsDir)).toEqual([`${hash}.pdf`]);
  });

  it('recovers a dead manual URL from the wayback machine', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manufacturer: 'IO Labs', name: 'Flux' });

    const deadUrl = 'https://www.iolabs.co.uk/_files/ugd/41c647_75128f017a3941ef8d5d518bc5b0ba9b.pdf';
    const snapshot = `https://web.archive.org/web/20241213043433/${deadUrl}`;
    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'IO Labs',
        module: 'Flux',
        pdf_urls: [deadUrl],
        product_page_url: 'https://www.iolabs.co.uk/flux',
      }),
    });
    // Route order matters: the availability and snapshot URLs both embed the
    // dead URL, so the catch-all 404 for the manufacturer site comes last.
    const fetchImpl = fakeFetch({
      'archive.org/wayback/available': {
        json: { archived_snapshots: { closest: { available: true, url: snapshot } } },
      },
      'web.archive.org/web/20241213043433': { body: PDF_BYTES },
      'iolabs.co.uk': { status: 404 },
    });
    const renderImpl = fakeRender({});

    const hash = await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      renderImpl,
    });
    expect(hash).toBe(PDF_HASH);
    // The archived PDF is the real manual: no page render happened and the
    // record is named as a manual, not a product-page stand-in.
    expect(renderImpl.calls).toEqual([]);
    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows[0].original_name).toBe('IO_Labs_Flux_Manual.pdf');
  });

  it('falls back to a wayback snapshot render as the last resort', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: [],
        product_page_url: 'https://makenoise.com/maths',
      }),
    });
    const snapshot = 'https://web.archive.org/web/2024/https://makenoise.com/maths';
    const fetchImpl = fakeFetch({
      'archive.org/advancedsearch.php': { json: { response: { docs: [] } } },
      'archive.org/wayback/available': {
        json: { archived_snapshots: { closest: { available: true, url: snapshot } } },
      },
    });
    // The live product page fails to render; only the snapshot works.
    const renderImpl = fakeRender({ 'web.archive.org': RENDER_A });

    const hash = await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      renderImpl,
    });
    expect(hash).toBe(RENDER_A_HASH);
    // Chain order: live page render, then archive.org search, then snapshot.
    expect(renderImpl.calls).toEqual(['https://makenoise.com/maths', snapshot]);
    const searchIdx = fetchImpl.requested.findIndex((u) => u.includes('advancedsearch'));
    const waybackIdx = fetchImpl.requested.findIndex((u) => u.includes('wayback/available'));
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(waybackIdx).toBeGreaterThan(searchIdx);

    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].original_name).toBe('Make_Noise_Maths_Product_Page.pdf');
  });

  it('replaces a stale product-page render instead of accumulating records', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const backend = fakeBackend({
      completeTextWithSearch: JSON.stringify({
        manufacturer: 'Make Noise',
        module: 'Maths',
        pdf_urls: [],
        product_page_url: 'https://makenoise.com/maths',
      }),
    });
    const fetchImpl = fakeFetch({});

    await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      renderImpl: fakeRender({ 'makenoise.com': RENDER_A }),
    });
    // Re-run: the page renders to different bytes, as real pages do.
    await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      renderImpl: fakeRender({ 'makenoise.com': RENDER_B }),
    });

    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(RENDER_B_HASH);
    expect(fs.readdirSync(manualsDir).sort()).toEqual([`${RENDER_B_HASH}.pdf`]);
  });

  it('supersedes an old render when a real manual PDF turns up', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id);

    const renderInfo = JSON.stringify({
      manufacturer: 'Make Noise',
      module: 'Maths',
      pdf_urls: [],
      product_page_url: 'https://makenoise.com/maths',
    });
    await findManualForModule(db, fakeBackend({ completeTextWithSearch: renderInfo }), module, manualsDir, {
      fetchImpl: fakeFetch({}),
      renderImpl: fakeRender({ 'makenoise.com': RENDER_A }),
    });

    const manualInfo = JSON.stringify({
      manufacturer: 'Make Noise',
      module: 'Maths',
      pdf_urls: ['https://makenoise.com/maths.pdf'],
      product_page_url: 'https://makenoise.com/maths',
    });
    const hash = await findManualForModule(
      db,
      fakeBackend({ completeTextWithSearch: manualInfo }),
      module,
      manualsDir,
      { fetchImpl: fakeFetch({ 'makenoise.com/maths.pdf': { body: PDF_BYTES } }), renderImpl: fakeRender({}) }
    );
    expect(hash).toBe(PDF_HASH);

    const { rows } = await db.query('SELECT * FROM manuals WHERE module_id = $1', [module.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].original_name).toBe('Make_Noise_Maths_Manual.pdf');
    expect(fs.readdirSync(manualsDir).sort()).toEqual([`${PDF_HASH}.pdf`]);
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
        group_label: null,
        port_kind: null,
        panel: null,
        values: [],
      },
      {
        type: 'other',
        name: 'Screen',
        description: null,
        voltage_min: null,
        voltage_max: null,
        polarity: null,
        group_label: null,
        port_kind: null,
        panel: null,
        values: [],
      },
    ]);
  });
});

describe('normalizeNormalizations', () => {
  it('keeps entries with a target and a source or label, trimming strings', () => {
    const normalizations = normalizeNormalizations([
      { target: ' IN 2 ', source: 'IN 1', description: ' Chained ' },
      { target: 'Filter In', source: null, source_label: 'internal oscillator' },
      { target: '', source: 'IN 1' },
      { target: 'IN 3' },
      'nope',
      null,
    ]);
    expect(normalizations).toEqual([
      {
        target: 'IN 2',
        target_panel: null,
        source: 'IN 1',
        source_panel: null,
        source_label: null,
        condition: null,
        alt_group: null,
        break_jack: null,
        break_on: 'cable_in',
        description: 'Chained',
      },
      {
        target: 'Filter In',
        target_panel: null,
        source: null,
        source_panel: null,
        source_label: 'internal oscillator',
        condition: null,
        alt_group: null,
        break_jack: null,
        break_on: 'cable_in',
        description: null,
      },
    ]);
  });
});

describe('resolveNormalizations', () => {
  const components = [
    { id: 1, name: 'IN 1', type: 'input_jack' },
    { id: 2, name: 'IN 2', type: 'input_jack' },
    { id: 3, name: 'Osc Out', type: 'output_jack' },
    { id: 4, name: 'Filter In', type: 'input_jack' },
  ];

  it('resolves names to component ids and derives the kind', () => {
    const rows = resolveNormalizations(
      normalizeNormalizations([
        { target: 'in 2', source: 'IN 1', description: 'Input chaining' },
        { target: 'Filter In', source: 'Osc Out' },
        { target: 'Filter In', source_label: 'internal noise source' },
      ]),
      components
    );
    expect(rows).toEqual([
      {
        target_component_id: 2,
        source_component_id: 1,
        source_label: null,
        kind: 'input',
        condition_component_id: null,
        condition_value: null,
        alt_group: null,
        break_component_id: null,
        break_on: 'cable_in',
        description: 'Input chaining',
      },
      {
        target_component_id: 4,
        source_component_id: 3,
        source_label: null,
        kind: 'output',
        condition_component_id: null,
        condition_value: null,
        alt_group: null,
        break_component_id: null,
        break_on: 'cable_in',
        description: null,
      },
      {
        target_component_id: 4,
        source_component_id: null,
        source_label: 'internal noise source',
        kind: 'internal',
        condition_component_id: null,
        condition_value: null,
        alt_group: null,
        break_component_id: null,
        break_on: 'cable_in',
        description: null,
      },
    ]);
  });

  it('drops unknown targets and self-references, keeps unresolved sources as labels, dedupes', () => {
    const rows = resolveNormalizations(
      normalizeNormalizations([
        { target: 'Nope', source: 'IN 1' },
        { target: 'IN 2', source: 'IN 2' },
        { target: 'IN 2', source: 'Mystery Out' },
        { target: 'IN 2', source: 'Mystery Out' },
      ]),
      components
    );
    expect(rows).toEqual([
      {
        target_component_id: 2,
        source_component_id: null,
        source_label: 'Mystery Out',
        kind: 'internal',
        condition_component_id: null,
        condition_value: null,
        alt_group: null,
        break_component_id: null,
        break_on: 'cable_in',
        description: null,
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
        normalizations: [
          {
            target: 'Signal In 1',
            source: 'EOR',
            description: 'EOR is normalled to the channel 1 input.',
          },
          { target: 'Signal In 1', source_label: 'internal +10V offset' },
        ],
      }),
    });

    const result = await analyzeManualForModule(db, backend, module, '/tmp/maths.pdf');
    expect(result.components).toHaveLength(3);
    expect(result.normalizations).toHaveLength(2);
    expect(backend.calls.analyzeDocument[0][0]).toContain('Make Noise Maths');

    const { rows: stored } = await db.query(
      'SELECT * FROM module_components WHERE module_id = $1 ORDER BY id',
      [module.id]
    );
    expect(stored).toHaveLength(3);
    expect(stored[0].type).toBe('input_jack');
    expect(stored[1].polarity).toBe('unipolar');
    expect(stored[2].voltage_min).toBeNull();

    const { rows: normalled } = await db.query(
      'SELECT * FROM component_normalizations WHERE module_id = $1 ORDER BY id',
      [module.id]
    );
    expect(normalled).toHaveLength(2);
    expect(normalled[0]).toMatchObject({
      target_component_id: stored[0].id,
      source_component_id: stored[1].id,
      kind: 'output',
      description: 'EOR is normalled to the channel 1 input.',
    });
    expect(normalled[1]).toMatchObject({
      target_component_id: stored[0].id,
      source_component_id: null,
      source_label: 'internal +10V offset',
      kind: 'internal',
    });

    const { rows: mod } = await db.query('SELECT * FROM modules WHERE id = $1', [module.id]);
    expect(mod[0].analysis_status).toBe('complete');
    expect(mod[0].summary).toContain('dual function generator');
  });

  // The width is a property of the module, and the manual is where it is
  // printed — so the analysis is the first thing that can record it.
  it('stores the panel width the manual states', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH });
    const backend = fakeBackend({
      analyzeDocument: '{"summary": "A VCO.", "hp": "12.3", "components": [{"type": "knob", "name": "Freq"}]}',
    });

    const result = await analyzeManualForModule(db, backend, module, '/tmp/vco.pdf');
    // Rounded to the nearest half HP, like every other width in the app.
    expect(result.hp).toBe(12.5);
    const { rows } = await db.query('SELECT hp FROM modules WHERE id = $1', [module.id]);
    expect(rows[0].hp).toBe(12.5);
    expect(backend.calls.analyzeDocument[0][0]).toContain('"hp"');
  });

  it('leaves a recorded width alone when the manual states none', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH, hp: 8 });
    const backend = fakeBackend({
      analyzeDocument: '{"summary": "A VCO.", "components": [{"type": "knob", "name": "Freq"}]}',
    });

    const result = await analyzeManualForModule(db, backend, module, '/tmp/vco.pdf');
    expect(result.hp).toBe(null);
    const { rows } = await db.query('SELECT hp FROM modules WHERE id = $1', [module.id]);
    expect(rows[0].hp).toBe(8);
  });

  it('replaces components and normalizations on re-analysis', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, { manual_hash: PDF_HASH });
    const { rows: stale } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES ($1, 'other', 'Stale') RETURNING id`,
      [module.id]
    );
    await db.query(
      `INSERT INTO component_normalizations (module_id, target_component_id, source_label, kind)
       VALUES ($1, $2, 'stale signal', 'internal')`,
      [module.id, stale[0].id]
    );

    const backend = fakeBackend({
      analyzeDocument: '{"summary": "New", "components": [{"type": "knob", "name": "Rise"}]}',
    });
    await analyzeManualForModule(db, backend, module, '/tmp/m.pdf');
    const { rows } = await db.query('SELECT name FROM module_components WHERE module_id = $1', [
      module.id,
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Rise']);
    const { rows: normalled } = await db.query(
      'SELECT * FROM component_normalizations WHERE module_id = $1',
      [module.id]
    );
    expect(normalled).toHaveLength(0);
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

  it('asks for every component type and for normalled connections in the prompt', () => {
    const prompt = ANALYSIS_TEMPLATE('Make Noise', 'Maths');
    for (const term of [
      'input_jack',
      'output_jack',
      'button',
      'toggle',
      'unipolar',
      'bipolar',
      'normalizations',
      'NORMALLED',
      'source_label',
    ]) {
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


describe('scopeQuestion', () => {
  async function fixture() {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    const { rows } = await db.query(
      `INSERT INTO questions (user_id, prompt, status)
       VALUES ($1, 'How do I patch a krell?', 'scoping') RETURNING *`,
      [user.id]
    );
    return { db, user, module, question: rows[0] };
  }

  it('links the scoped modules and marks the question scoped', async () => {
    const { db, module, question } = await fixture();
    const backend = fakeBackend({
      completeText: '[{"manufacturer": "Make Noise", "module": "Maths"}]',
    });

    const scoped = await scopeQuestion(db, backend, question);
    expect(scoped.map((m) => m.id)).toEqual([module.id]);

    const { rows: links } = await db.query(
      'SELECT * FROM question_modules WHERE question_id = $1',
      [question.id]
    );
    expect(links).toHaveLength(1);
    expect(links[0].module_id).toBe(module.id);
    const { rows: q } = await db.query('SELECT status FROM questions WHERE id = $1', [
      question.id,
    ]);
    expect(q[0].status).toBe('scoped');
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
    });

    await scopeQuestion(db, backend, question);
    const { rows: links } = await db.query(
      'SELECT component_id FROM question_components WHERE question_id = $1',
      [question.id]
    );
    expect(links.map((l) => l.component_id)).toEqual([jacks[1].id]);
  });

  // A question asked about a patch is about the modules that patch uses,
  // whatever the model makes of the wording.
  it('puts the modules an attached patch uses in scope', async () => {
    const { db, user, module, question } = await fixture();
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'output_jack', 'EOR'), ($1, 'input_jack', 'Signal In') RETURNING id, name`,
      [module.id]
    );
    const { rows: patch } = await db.query(
      `INSERT INTO patches (user_id, rack_name, name) VALUES ($1, 'main rack', 'Krell') RETURNING *`,
      [user.id]
    );
    const { rows: pm } = await db.query(
      `INSERT INTO patch_modules (patch_id, module_id, manufacturer, module_name)
       VALUES ($1, $2, 'Make Noise', 'Maths') RETURNING *`,
      [patch[0].id, module.id]
    );
    await db.query(
      `INSERT INTO patch_cables
         (patch_id, from_patch_module_id, from_component_id, from_component_name,
          to_patch_module_id, to_component_id, to_component_name)
       VALUES ($1, $2, $3, 'EOR', $2, $4, 'Signal In')`,
      [patch[0].id, pm[0].id, jacks[0].id, jacks[1].id]
    );
    await db.query('INSERT INTO question_patches (question_id, patch_id) VALUES ($1, $2)', [
      question.id,
      patch[0].id,
    ]);

    // The model finds nothing; the patch still puts its module in scope.
    const backend = fakeBackend({ completeText: '[]' });
    await scopeQuestion(db, backend, question);
    const { rows: links } = await db.query('SELECT module_id FROM question_modules');
    expect(links.map((l) => l.module_id)).toEqual([module.id]);
  });

  it('leaves the scope empty when no modules match', async () => {
    const { db, question } = await fixture();
    const backend = fakeBackend({ completeText: '[]' });

    const scoped = await scopeQuestion(db, backend, question);
    expect(scoped).toEqual([]);

    const { rows: links } = await db.query('SELECT * FROM question_modules');
    expect(links).toHaveLength(0);
    const { rows: q } = await db.query('SELECT status FROM questions WHERE id = $1', [
      question.id,
    ]);
    expect(q[0].status).toBe('scoped');
  });

  it('still scopes when component scoping fails', async () => {
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
    });
    await scopeQuestion(db, backend, question);
    const { rows: links } = await db.query('SELECT * FROM question_modules');
    expect(links.map((l) => l.module_id)).toEqual([module.id]);
    const { rows: components } = await db.query('SELECT * FROM question_components');
    expect(components).toHaveLength(0);
    const { rows: q } = await db.query('SELECT status FROM questions WHERE id = $1', [
      question.id,
    ]);
    expect(q[0].status).toBe('scoped');
  });

  it('fails when the user has no modules', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'empty' });
    const { rows } = await db.query(
      `INSERT INTO questions (user_id, prompt, status) VALUES ($1, 'Q', 'scoping') RETURNING *`,
      [user.id]
    );
    const backend = fakeBackend();
    await expect(scopeQuestion(db, backend, rows[0])).rejects.toThrow(/No modules imported/);
    expect(backend.calls.completeText).toHaveLength(0);
  });
});

describe('answerQuestion', () => {
  // A reviewed question: module linked, shared manual attached.
  async function fixture() {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    fs.writeFileSync(path.join(manualsDir, `${PDF_HASH}.pdf`), PDF_BYTES);
    const module = await insertModule(db, user.id, {
      manual_hash: PDF_HASH,
      manual_status: 'found',
    });
    const { rows: manuals } = await db.query('SELECT id FROM manuals WHERE module_id = $1', [
      module.id,
    ]);
    const { rows } = await db.query(
      `INSERT INTO questions (user_id, prompt, status)
       VALUES ($1, 'How do I patch a krell?', 'pending') RETURNING *`,
      [user.id]
    );
    const question = rows[0];
    await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
      question.id,
      module.id,
    ]);
    await db.query('INSERT INTO question_manuals (question_id, manual_id) VALUES ($1, $2)', [
      question.id,
      manuals[0].id,
    ]);
    return { db, user, module, manualId: manuals[0].id, question };
  }

  // Reading a PDF costs the model a rendered page at a time; the same manual
  // as extracted markdown is a fraction of that, and it is already stored.
  describe('sending the manual as text rather than as a PDF', () => {
    // Give the fixture's manual its extracted text.
    const withText = async (db, manualId, content) => {
      const { rows } = await db.query('SELECT * FROM manuals WHERE id = $1', [manualId]);
      return insertManualText(db, rows[0], { title: 'Maths', content });
    };

    it('sends the extracted text, and never the PDF, when there is text', async () => {
      const { db, question, manualId } = await fixture();
      await withText(db, manualId, '# Maths\n\nEOR goes high at the end of the rise.');
      const backend = fakeBackend({ answerWithDocuments: 'ok' });

      await answerQuestion(db, backend, question, manualsDir);
      const [, manuals] = backend.calls.answerWithDocuments[0];
      expect(manuals).toHaveLength(1);
      expect(manuals[0]).toMatch(/\.md$/);
      expect(manuals[0]).not.toContain(manualsDir);
      // Named after the module, so an answer can say which manual it read.
      expect(path.basename(manuals[0])).toBe('Make_Noise_Maths_manual.md');
    });

    // The file only has to exist for the one call that reads it.
    it('writes the text where the backend can read it, and clears up after', async () => {
      const { db, question, manualId } = await fixture();
      await withText(db, manualId, '# Maths\n\nEOR goes high at the end of the rise.');
      let seen = null;
      const backend = fakeBackend({
        answerWithDocuments: (prompt, manuals) => {
          seen = { path: manuals[0], content: fs.readFileSync(manuals[0], 'utf-8') };
          return 'ok';
        },
      });

      await answerQuestion(db, backend, question, manualsDir);
      expect(seen.content).toContain('EOR goes high');
      expect(fs.existsSync(seen.path)).toBe(false);
      expect(fs.existsSync(path.dirname(seen.path))).toBe(false);
    });

    it('clears up even when the answer fails', async () => {
      const { db, question, manualId } = await fixture();
      await withText(db, manualId, '# Maths\n\nEOR goes high at the end of the rise.');
      let dir = null;
      const backend = fakeBackend({
        answerWithDocuments: (prompt, manuals) => {
          dir = path.dirname(manuals[0]);
          throw new Error('out of tokens');
        },
      });

      await expect(answerQuestion(db, backend, question, manualsDir)).rejects.toThrow(/out of/);
      expect(fs.existsSync(dir)).toBe(false);
    });

    // A manual that is a scan extracts to nothing; the PDF is all there is.
    it('falls back to the PDF for a manual with no text worth sending', async () => {
      const { db, question, manualId } = await fixture();
      await withText(db, manualId, 'x');
      const backend = fakeBackend({ answerWithDocuments: 'ok' });

      await answerQuestion(db, backend, question, manualsDir);
      const [, manuals] = backend.calls.answerWithDocuments[0];
      expect(manuals).toEqual([path.join(manualsDir, `${PDF_HASH}.pdf`)]);
    });

    it('mixes the two when only some manuals have been extracted', async () => {
      const { db, user, question } = await fixture();
      // A second module, with its own manual and no extracted text.
      const other = await insertModule(db, user.id, {
        manufacturer: 'ALM',
        name: 'Pam',
        manual_hash: OTHER_HASH,
      });
      fs.writeFileSync(path.join(manualsDir, `${OTHER_HASH}.pdf`), PDF_BYTES);
      const { rows } = await db.query('SELECT id FROM manuals WHERE module_id = $1', [other.id]);
      await db.query('INSERT INTO question_manuals (question_id, manual_id) VALUES ($1, $2)', [
        question.id,
        rows[0].id,
      ]);
      await db.query('INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)', [
        question.id,
        other.id,
      ]);
      const { rows: mine } = await db.query('SELECT id FROM manuals WHERE module_id != $1', [
        other.id,
      ]);
      await withText(db, mine[0].id, '# Maths\n\nEOR goes high at the end of the rise.');

      const backend = fakeBackend({ answerWithDocuments: 'ok' });
      await answerQuestion(db, backend, question, manualsDir);
      const [, manuals] = backend.calls.answerWithDocuments[0];
      expect(manuals.filter((p) => p.endsWith('.md'))).toHaveLength(1);
      expect(manuals.filter((p) => p.endsWith('.pdf'))).toEqual([
        path.join(manualsDir, `${OTHER_HASH}.pdf`),
      ]);
    });
  });

  it('answers with the linked modules and attached manuals, and saves', async () => {
    const { db, question } = await fixture();
    const backend = fakeBackend({ answerWithDocuments: 'Patch it like this...' });

    const updated = await answerQuestion(db, backend, question, manualsDir);
    expect(updated.status).toBe('answered');
    expect(updated.answer).toBe('Patch it like this...');
    expect(updated.answered_at).toBeTruthy();

    // The reviewed scope is used as-is: no LLM scoping at answer time.
    expect(backend.calls.completeText).toHaveLength(0);

    const [prompt, pdfs] = backend.calls.answerWithDocuments[0];
    expect(prompt).toContain('How do I patch a krell?');
    expect(prompt).toContain('Make Noise Maths');
    expect(pdfs).toEqual([path.join(manualsDir, `${PDF_HASH}.pdf`)]);
  });

  it('describes normalled connections of in-scope modules in the prompt', async () => {
    const { db, module, question } = await fixture();
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'input_jack', 'Filter In'),
         ($1, 'output_jack', 'Osc Out') RETURNING id, name`,
      [module.id]
    );
    const filterIn = jacks.find((j) => j.name === 'Filter In');
    const oscOut = jacks.find((j) => j.name === 'Osc Out');
    await db.query(
      `INSERT INTO component_normalizations
         (module_id, target_component_id, source_component_id, kind, description)
       VALUES ($1, $2, $3, 'output', 'The oscillator feeds the filter by default.')`,
      [module.id, filterIn.id, oscOut.id]
    );
    await db.query(
      `INSERT INTO component_normalizations (module_id, target_component_id, source_label, kind)
       VALUES ($1, $2, 'internal noise source', 'internal')`,
      [module.id, filterIn.id]
    );

    const backend = fakeBackend({ answerWithDocuments: 'ok' });
    await answerQuestion(db, backend, question, manualsDir);
    const [prompt] = backend.calls.answerWithDocuments[0];
    expect(prompt).toContain('normalled (default, unpatched) connections');
    expect(prompt).toContain(
      '- Make Noise Maths: "Filter In" is normalled to the "Osc Out" output — The oscillator feeds the filter by default.'
    );
    expect(prompt).toContain(
      '- Make Noise Maths: "Filter In" is normalled to the internal signal "internal noise source"'
    );
  });

  it('feeds attached previous answers and notes as text documents', async () => {
    const { db, user, question } = await fixture();
    const { rows: prev } = await db.query(
      `INSERT INTO questions (user_id, prompt, answer, status, answered_at)
       VALUES ($1, 'Earlier question', 'Earlier answer', 'answered', now()) RETURNING *`,
      [user.id]
    );
    await db.query(
      'INSERT INTO question_answers (question_id, source_question_id) VALUES ($1, $2)',
      [question.id, prev[0].id]
    );
    const { rows: note } = await db.query(
      `INSERT INTO notes (user_id, title, body) VALUES ($1, 'Patch idea', 'Krell into VCA') RETURNING *`,
      [user.id]
    );
    await db.query('INSERT INTO question_notes (question_id, note_id) VALUES ($1, $2)', [
      question.id,
      note[0].id,
    ]);

    const backend = fakeBackend({ answerWithDocuments: 'ok' });
    await answerQuestion(db, backend, question, manualsDir);
    const [prompt, , textDocs] = backend.calls.answerWithDocuments[0];
    expect(textDocs).toHaveLength(2);
    expect(textDocs[0].text).toContain('Earlier answer');
    expect(textDocs[1].text).toContain('Patch idea');
    expect(textDocs[1].text).toContain('Krell into VCA');
    expect(prompt).toContain('previous question-and-answer documents');
    expect(prompt).toContain("the user's own notes");
  });

  // Asking about a patch: the answer has to see what is plugged into what,
  // how the controls are set, and what the module's own defaults do about it.
  it('feeds an attached patch as a document of its cables, settings and flow', async () => {
    const { db, user, module, question } = await fixture();
    const { rows: jacks } = await db.query(
      `INSERT INTO module_components (module_id, type, name) VALUES
         ($1, 'output_jack', 'EOR'), ($1, 'input_jack', 'Signal In'), ($1, 'knob', 'Rise')
       RETURNING id, name`,
      [module.id]
    );
    const byName = new Map(jacks.map((j) => [j.name, j.id]));
    // A normalled default the patch's cable cancels.
    await db.query(
      `INSERT INTO component_normalizations (module_id, target_component_id, source_label, kind)
       VALUES ($1, $2, 'internal noise source', 'internal')`,
      [module.id, byName.get('Signal In')]
    );
    const { rows: patch } = await db.query(
      `INSERT INTO patches (user_id, rack_name, name, description)
       VALUES ($1, 'main rack', 'Krell', 'A self-playing patch.') RETURNING *`,
      [user.id]
    );
    const { rows: pm } = await db.query(
      `INSERT INTO patch_modules (patch_id, module_id, manufacturer, module_name)
       VALUES ($1, $2, 'Make Noise', 'Maths') RETURNING *`,
      [patch[0].id, module.id]
    );
    await db.query(
      `INSERT INTO patch_cables
         (patch_id, from_patch_module_id, from_component_id, from_component_name,
          to_patch_module_id, to_component_id, to_component_name)
       VALUES ($1, $2, $3, 'EOR', $2, $4, 'Signal In')`,
      [patch[0].id, pm[0].id, byName.get('EOR'), byName.get('Signal In')]
    );
    await db.query(
      `INSERT INTO patch_settings (patch_id, patch_module_id, component_id, component_name, value)
       VALUES ($1, $2, $3, 'Rise', '7')`,
      [patch[0].id, pm[0].id, byName.get('Rise')]
    );
    await db.query('INSERT INTO question_patches (question_id, patch_id) VALUES ($1, $2)', [
      question.id,
      patch[0].id,
    ]);

    const backend = fakeBackend({ answerWithDocuments: 'ok' });
    await answerQuestion(db, backend, question, manualsDir);
    const [prompt, , textDocs] = backend.calls.answerWithDocuments[0];
    const doc = textDocs.find((d) => d.name === `patch-${patch[0].id}.md`);
    expect(doc).toBeTruthy();
    expect(doc.text).toContain('# Patch: Krell');
    expect(doc.text).toContain('A self-playing patch.');
    expect(doc.text).toContain('- Make Noise Maths "EOR" → Make Noise Maths "Signal In"');
    expect(doc.text).toContain('- Make Noise Maths "Rise": 7');
    // The cable cancels the module's default, and the document says so.
    expect(doc.text).toContain('CANCELLED in this patch');
    expect(prompt).toContain('a description of the patch itself');
    expect(prompt).toContain('do not assume connections it does not list');
  });

  it('answers from notes alone when the attached manual file is invalid', async () => {
    const { db, user, question } = await fixture();
    fs.rmSync(path.join(manualsDir, `${PDF_HASH}.pdf`));
    const { rows: note } = await db.query(
      `INSERT INTO notes (user_id, body) VALUES ($1, 'Only a note') RETURNING *`,
      [user.id]
    );
    await db.query('INSERT INTO question_notes (question_id, note_id) VALUES ($1, $2)', [
      question.id,
      note[0].id,
    ]);

    const backend = fakeBackend({ answerWithDocuments: 'ok' });
    const updated = await answerQuestion(db, backend, question, manualsDir);
    expect(updated.status).toBe('answered');
    const [, pdfs, textDocs] = backend.calls.answerWithDocuments[0];
    expect(pdfs).toEqual([]);
    expect(textDocs).toHaveLength(1);
  });

  it('fails when no modules are linked to the question', async () => {
    const { db, question } = await fixture();
    await db.query('DELETE FROM question_modules');
    const backend = fakeBackend();
    await expect(answerQuestion(db, backend, question, manualsDir)).rejects.toThrow(/in scope/);
  });

  it('fails when nothing valid is attached', async () => {
    const { db, question } = await fixture();
    await db.query('DELETE FROM question_manuals');
    const backend = fakeBackend();
    await expect(answerQuestion(db, backend, question, manualsDir)).rejects.toThrow(
      /No readable manuals/
    );
  });
});
