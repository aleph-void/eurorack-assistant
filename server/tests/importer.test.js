import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  parseModuleLines,
  parseModuleCsv,
  fetchModulargridRack,
  importModules,
} from '../src/services/importer.js';
import { createTestDb, createUser, fakeFetch } from './helpers.js';

describe('parseCsv', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    expect(parseCsv('"a,b","c""d"\ne,f')).toEqual([
      ['a,b', 'c"d'],
      ['e', 'f'],
    ]);
  });

  it('handles CRLF line endings and skips blank lines', () => {
    expect(parseCsv('a,b\r\n\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseModuleLines', () => {
  it('parses manufacturer,module lines', () => {
    expect(parseModuleLines('Make Noise,Maths\nMutable Instruments,Beads')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1, hp: null },
      { manufacturer: 'Mutable Instruments', name: 'Beads', quantity: 1, hp: null },
    ]);
  });

  it('keeps free-text lines with no comma as name-only items', () => {
    expect(parseModuleLines('Make Noise Maths')).toEqual([
      { manufacturer: '', name: 'Make Noise Maths', quantity: 1, hp: null },
    ]);
  });

  it('collapses duplicate lines into a quantity count', () => {
    expect(parseModuleLines('Make Noise,Maths\nmake noise,maths')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2, hp: null },
    ]);
  });

  it('takes a width written on the end of a name out of the name', () => {
    expect(parseModuleLines('Make Noise,Maths 20HP\nMutable Instruments,Beads (16 hp)')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1, hp: 20 },
      { manufacturer: 'Mutable Instruments', name: 'Beads', quantity: 1, hp: 16 },
    ]);
  });

  it('keeps a trailing number that is part of the name', () => {
    expect(parseModuleLines('Doepfer,A-100HP\nIntellijel,Quad VCA 12')).toEqual([
      { manufacturer: 'Doepfer', name: 'A-100HP', quantity: 1, hp: null },
      { manufacturer: 'Intellijel', name: 'Quad VCA 12', quantity: 1, hp: null },
    ]);
  });

  it('collapses a line with a width and one without into the same module', () => {
    expect(parseModuleLines('Make Noise,Maths 20HP\nMake Noise,Maths')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2, hp: 20 },
    ]);
  });

  it('skips blank lines and comments', () => {
    expect(parseModuleLines('# my rack\n\nMake Noise,Maths\n')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1, hp: null },
    ]);
  });

  it('skips a CSV column-name header on the first line', () => {
    const text =
      '"manufacturer","module","quantity","manual file name"\n' + 'Make Noise,Maths\n';
    expect(parseModuleLines(text)).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1, hp: null },
    ]);
  });
});

describe('parseModuleCsv', () => {
  it('parses a README.csv-style file with a header', () => {
    const csv =
      '"manufacturer","module","quantity","manual file name"\n' +
      '"Make Noise","Maths",2,"Make_Noise_Maths_Manual.pdf"\n';
    expect(parseModuleCsv(csv)).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2, hp: null },
    ]);
  });

  it('parses a headerless CSV and defaults quantity to 1', () => {
    expect(parseModuleCsv('"Make Noise","Maths"\n"ALM","Pamela\'s NEW Workout",abc')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1, hp: null },
      { manufacturer: 'ALM', name: "Pamela's NEW Workout", quantity: 1, hp: null },
    ]);
  });

  it('reads an hp column named in the header, wherever it sits', () => {
    const csv =
      '"manufacturer","module","hp","quantity"\n' + '"Make Noise","Maths","20HP",2\n';
    expect(parseModuleCsv(csv)).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2, hp: 20 },
    ]);
  });

  it('leaves hp null when a headerless CSV has no width column', () => {
    expect(parseModuleCsv('"Make Noise","Maths",1,"maths.pdf"')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1, hp: null },
    ]);
  });

  it('skips rows missing manufacturer or module', () => {
    expect(parseModuleCsv('"Make Noise",""\n"","Maths"\n"ALM","Squid Salmple",1')).toEqual([
      { manufacturer: 'ALM', name: 'Squid Salmple', quantity: 1, hp: null },
    ]);
  });
});

describe('fetchModulargridRack', () => {
  const rackJson = {
    rack: {
      Rack: { name: 'My Rack' },
      Module: [
        { name: 'Maths', Vendor: { name: 'Make Noise' }, hp: 20 },
        { name: 'Maths', Vendor: { name: 'Make Noise' }, hp: 20 },
        { name: 'Beads', Vendor: { name: 'Mutable Instruments' }, hp: '16' },
        { name: '', Vendor: { name: 'Ghost' } },
      ],
    },
  };

  it('extracts the rack id and parses the embedded module JSON', async () => {
    const html = `<html><script>var x = ${JSON.stringify(rackJson)};</script></html>`;
    const fetchImpl = fakeFetch({ 'modulargrid.net/e/racks/view/2250471': { text: html } });
    const items = await fetchModulargridRack(
      'https://modulargrid.net/e/modules_racks/data_sheet/2250471',
      { fetchImpl }
    );
    expect(items).toEqual([
      // Only the names come from here: a width stated by the rack planner is
      // ignored, since module data is taken from manuals and product pages.
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2, hp: null },
      { manufacturer: 'Mutable Instruments', name: 'Beads', quantity: 1, hp: null },
    ]);
  });

  it('rejects URLs without a rack id', async () => {
    await expect(fetchModulargridRack('https://example.com/rack', {})).rejects.toThrow(
      /ModularGrid rack id/
    );
  });

  it('rejects pages without rack data', async () => {
    const fetchImpl = fakeFetch({ modulargrid: { text: '<html>login required</html>' } });
    await expect(
      fetchModulargridRack('https://modulargrid.net/e/racks/view/123', { fetchImpl })
    ).rejects.toThrow(/No rack data/);
  });
});

describe('importModules', () => {
  it('creates new module rows and replaces the rack quantity on re-import', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u1' });

    const first = await importModules(db, user.id, 'main rack', [
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1 },
    ]);
    expect(first.rack.name).toBe('main rack');
    expect(first.results[0].created).toBe(true);
    expect(first.results[0].added).toBe(true);
    expect(first.results[0].quantity).toBe(1);

    // The rack name matches case-insensitively — no duplicate rack.
    const second = await importModules(db, user.id, 'Main Rack', [
      { manufacturer: 'make noise', name: 'MATHS', quantity: 2 },
    ]);
    expect(second.rack.id).toBe(first.rack.id);
    expect(second.results[0].created).toBe(false);
    expect(second.results[0].added).toBe(false);
    expect(second.results[0].quantity).toBe(2);
    expect(second.results[0].module.id).toBe(first.results[0].module.id);

    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(1);
    const { rows: racks } = await db.query('SELECT * FROM racks');
    expect(racks).toHaveLength(1);
    const { rows: mappings } = await db.query('SELECT quantity FROM rack_modules');
    expect(mappings).toEqual([{ quantity: 2 }]);
  });

  it('shares one module record between users, with per-rack quantities', async () => {
    const db = await createTestDb();
    const u1 = await createUser(db, { username: 'u1' });
    const u2 = await createUser(db, { username: 'u2' });
    const r1 = await importModules(db, u1.id, 'main rack', [
      { manufacturer: 'ALM', name: 'Pam', quantity: 1 },
    ]);
    const r2 = await importModules(db, u2.id, 'main rack', [
      { manufacturer: 'ALM', name: 'Pam', quantity: 2 },
    ]);

    // One shared module record; each user gets their own rack and mapping.
    expect(r2.results[0].created).toBe(false);
    expect(r2.results[0].added).toBe(true);
    expect(r2.results[0].module.id).toBe(r1.results[0].module.id);
    expect(r2.rack.id).not.toBe(r1.rack.id);
    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(1);
    const { rows: mappings } = await db.query(
      'SELECT rm.quantity FROM rack_modules rm JOIN racks r ON r.id = rm.rack_id ORDER BY r.user_id'
    );
    expect(mappings.map((m) => m.quantity)).toEqual([1, 2]);
  });

  it('keeps the same module in two racks of one user independently', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u1' });
    await importModules(db, user.id, 'main rack', [
      { manufacturer: 'ALM', name: 'Pam', quantity: 1 },
    ]);
    const second = await importModules(db, user.id, 'travel case', [
      { manufacturer: 'ALM', name: 'Pam', quantity: 2 },
    ]);

    expect(second.results[0].created).toBe(false);
    expect(second.results[0].added).toBe(true);
    expect(second.results[0].quantity).toBe(2);
    const { rows: racks } = await db.query('SELECT * FROM racks ORDER BY id');
    expect(racks.map((r) => r.name)).toEqual(['main rack', 'travel case']);
    const { rows: mappings } = await db.query(
      'SELECT rm.quantity FROM rack_modules rm JOIN racks r ON r.id = rm.rack_id ORDER BY r.id'
    );
    expect(mappings.map((m) => m.quantity)).toEqual([1, 2]);
  });
});
