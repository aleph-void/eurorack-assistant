import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isProbablyPdf,
  safeManualName,
  downloadPdf,
  findChrome,
  renderPageToPdf,
} from '../src/services/pdf.js';
import { PDF_BYTES, fakeFetch } from './helpers.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isProbablyPdf', () => {
  it('accepts a valid PDF header', () => {
    const p = path.join(dir, 'ok.pdf');
    fs.writeFileSync(p, PDF_BYTES);
    expect(isProbablyPdf(p).ok).toBe(true);
  });

  it('rejects a missing file', () => {
    expect(isProbablyPdf(path.join(dir, 'missing.pdf'))).toEqual({
      ok: false,
      reason: 'file does not exist',
    });
  });

  it('rejects a tiny file', () => {
    const p = path.join(dir, 'tiny.pdf');
    fs.writeFileSync(p, 'ab');
    expect(isProbablyPdf(p).ok).toBe(false);
  });

  it('rejects an HTML file pretending to be a PDF', () => {
    const p = path.join(dir, 'fake.pdf');
    fs.writeFileSync(p, '<!doctype html><html>not a pdf</html>');
    const result = isProbablyPdf(p);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing PDF header/);
  });
});

describe('safeManualName', () => {
  it('builds a sanitized filename', () => {
    expect(safeManualName('Make Noise', 'Maths')).toBe('Make_Noise_Maths_Manual.pdf');
  });

  it('strips special characters', () => {
    expect(safeManualName('Mutable/Instruments', 'Beads (2020)')).toBe(
      'Mutable_Instruments_Beads_2020__Manual.pdf'
    );
  });
});

describe('findChrome', () => {
  it('finds an executable chrome name on PATH', () => {
    fs.writeFileSync(path.join(dir, 'chromium'), '#!/bin/sh\n', { mode: 0o755 });
    expect(findChrome({ PATH: dir })).toBe(path.join(dir, 'chromium'));
  });

  it('returns null when nothing matches', () => {
    expect(findChrome({ PATH: dir })).toBe(null);
  });
});

describe('renderPageToPdf', () => {
  const chromePath = '/usr/bin/fake-chrome';

  it('renders a page and validates the output', async () => {
    const dest = path.join(dir, 'page.pdf');
    const execImpl = (bin, args, opts, cb) => {
      expect(bin).toBe(chromePath);
      expect(args).toContain(`--print-to-pdf=${dest}`);
      expect(args[args.length - 1]).toBe('https://example.com/page');
      fs.writeFileSync(dest, PDF_BYTES);
      cb(null);
    };
    expect(
      await renderPageToPdf('https://example.com/page', dest, { chromePath, execImpl })
    ).toBe(true);
    expect(isProbablyPdf(dest).ok).toBe(true);
  });

  it('keeps a valid PDF even when chrome exits with an error', async () => {
    const dest = path.join(dir, 'page.pdf');
    const execImpl = (bin, args, opts, cb) => {
      fs.writeFileSync(dest, PDF_BYTES);
      cb(new Error('timed out'));
    };
    expect(
      await renderPageToPdf('https://example.com/page', dest, { chromePath, execImpl })
    ).toBe(true);
  });

  it('cleans up when chrome produces no valid PDF', async () => {
    const dest = path.join(dir, 'page.pdf');
    const execImpl = (bin, args, opts, cb) => {
      fs.writeFileSync(dest, '<html>not a pdf</html>');
      cb(null);
    };
    expect(
      await renderPageToPdf('https://example.com/page', dest, { chromePath, execImpl })
    ).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('fails without invoking anything when no chrome binary exists', async () => {
    const dest = path.join(dir, 'page.pdf');
    let called = false;
    const execImpl = (bin, args, opts, cb) => {
      called = true;
      cb(null);
    };
    expect(
      await renderPageToPdf('https://example.com/page', dest, { chromePath: null, execImpl })
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe('downloadPdf', () => {
  it('downloads and validates a PDF', async () => {
    const fetchImpl = fakeFetch({ 'example.com/manual.pdf': { body: PDF_BYTES } });
    const dest = path.join(dir, 'out.pdf');
    expect(await downloadPdf('https://example.com/manual.pdf', dest, { fetchImpl })).toBe(true);
    expect(isProbablyPdf(dest).ok).toBe(true);
  });

  it('rejects a non-PDF response and cleans up', async () => {
    const fetchImpl = fakeFetch({ 'example.com': { text: '<html>404</html>' } });
    const dest = path.join(dir, 'out.pdf');
    expect(await downloadPdf('https://example.com/manual.pdf', dest, { fetchImpl })).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('retries with browser headers after an HTTP error', async () => {
    let count = 0;
    const fetchImpl = fakeFetch({
      'example.com': () => {
        count += 1;
        return count === 1 ? { status: 403 } : { body: PDF_BYTES };
      },
    });
    const dest = path.join(dir, 'out.pdf');
    expect(await downloadPdf('https://example.com/manual.pdf', dest, { fetchImpl })).toBe(true);
    expect(count).toBe(2);
  });
});
