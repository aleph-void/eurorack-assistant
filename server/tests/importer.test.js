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
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1 },
      { manufacturer: 'Mutable Instruments', name: 'Beads', quantity: 1 },
    ]);
  });

  it('keeps free-text lines with no comma as name-only items', () => {
    expect(parseModuleLines('Make Noise Maths')).toEqual([
      { manufacturer: '', name: 'Make Noise Maths', quantity: 1 },
    ]);
  });

  it('collapses duplicate lines into a quantity count', () => {
    expect(parseModuleLines('Make Noise,Maths\nmake noise,maths')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2 },
    ]);
  });

  it('skips blank lines and comments', () => {
    expect(parseModuleLines('# my rack\n\nMake Noise,Maths\n')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1 },
    ]);
  });
});

describe('parseModuleCsv', () => {
  it('parses a README.csv-style file with a header', () => {
    const csv =
      '"manufacturer","module","quantity","manual file name"\n' +
      '"Make Noise","Maths",2,"Make_Noise_Maths_Manual.pdf"\n';
    expect(parseModuleCsv(csv)).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2 },
    ]);
  });

  it('parses a headerless CSV and defaults quantity to 1', () => {
    expect(parseModuleCsv('"Make Noise","Maths"\n"ALM","Pamela\'s NEW Workout",abc')).toEqual([
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1 },
      { manufacturer: 'ALM', name: "Pamela's NEW Workout", quantity: 1 },
    ]);
  });

  it('skips rows missing manufacturer or module', () => {
    expect(parseModuleCsv('"Make Noise",""\n"","Maths"\n"ALM","Squid Salmple",1')).toEqual([
      { manufacturer: 'ALM', name: 'Squid Salmple', quantity: 1 },
    ]);
  });
});

describe('fetchModulargridRack', () => {
  const rackJson = {
    rack: {
      Rack: { name: 'My Rack' },
      Module: [
        { name: 'Maths', Vendor: { name: 'Make Noise' } },
        { name: 'Maths', Vendor: { name: 'Make Noise' } },
        { name: 'Beads', Vendor: { name: 'Mutable Instruments' } },
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
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 2 },
      { manufacturer: 'Mutable Instruments', name: 'Beads', quantity: 1 },
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
  it('creates new module rows and increments the user quantity for duplicates', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u1' });

    const first = await importModules(db, user.id, [
      { manufacturer: 'Make Noise', name: 'Maths', quantity: 1 },
    ]);
    expect(first[0].created).toBe(true);
    expect(first[0].added).toBe(true);
    expect(first[0].quantity).toBe(1);

    const second = await importModules(db, user.id, [
      { manufacturer: 'make noise', name: 'MATHS', quantity: 2 },
    ]);
    expect(second[0].created).toBe(false);
    expect(second[0].added).toBe(false);
    expect(second[0].quantity).toBe(3);
    expect(second[0].module.id).toBe(first[0].module.id);

    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(1);
  });

  it('shares one module record between users, with per-user quantities', async () => {
    const db = await createTestDb();
    const u1 = await createUser(db, { username: 'u1' });
    const u2 = await createUser(db, { username: 'u2' });
    const r1 = await importModules(db, u1.id, [{ manufacturer: 'ALM', name: 'Pam', quantity: 1 }]);
    const r2 = await importModules(db, u2.id, [{ manufacturer: 'ALM', name: 'Pam', quantity: 2 }]);

    // One shared module record, two user mappings.
    expect(r2[0].created).toBe(false);
    expect(r2[0].added).toBe(true);
    expect(r2[0].module.id).toBe(r1[0].module.id);
    const { rows: modules } = await db.query('SELECT * FROM modules');
    expect(modules).toHaveLength(1);
    const { rows: mappings } = await db.query('SELECT * FROM user_modules ORDER BY user_id');
    expect(mappings).toHaveLength(2);
    expect(mappings.map((m) => m.quantity)).toEqual([1, 2]);
  });
});
