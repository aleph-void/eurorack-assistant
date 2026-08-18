import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { safeFetch, assertUrlAllowed, BlockedUrlError } from './safeFetch.js';

// A manual PDF that would fill the disk is refused: real module manuals are a
// few MB, and this is the ceiling a discovery job streams to before giving up.
export const MAX_PDF_BYTES = 128 * 1024 * 1024;

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Fuller Chrome-on-Windows desktop headers, used as a retry when a server
// rejects the plain USER_AGENT (e.g. Cloudflare returning 403 for bots).
export const CHROME_DESKTOP_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'application/pdf,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function isProbablyPdf(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'file does not exist' };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, reason: 'not a file' };
    if (stat.size < 8) return { ok: false, reason: 'file too small' };
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    if (!head.equals(Buffer.from('%PDF-'))) {
      return { ok: false, reason: `missing PDF header (%PDF-), got ${head.toString('latin1')}` };
    }
    return { ok: true, reason: 'ok' };
  } catch (e) {
    return { ok: false, reason: `exception while checking PDF: ${e.message}` };
  }
}

export function isProbablyPdfBuffer(data) {
  if (data.length < 8) return { ok: false, reason: 'file too small' };
  const head = data.subarray(0, 5);
  if (!head.equals(Buffer.from('%PDF-'))) {
    return { ok: false, reason: `missing PDF header (%PDF-), got ${head.toString('latin1')}` };
  }
  return { ok: true, reason: 'ok' };
}

export function sha256Buffer(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

// Documents are content-addressed: the stored file name is the sha256 of the
// PDF bytes, so identical documents land on the same file.
export function manualPath(manualsDir, hash) {
  return path.join(manualsDir, `${hash}.pdf`);
}

export function safeManualName(manufacturer, module, suffix = 'Manual') {
  const base = `${manufacturer}_${module}_${suffix}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base}.pdf`;
}

const CHROME_NAMES = ['google-chrome', 'chromium', 'chromium-browser', 'chrome'];

function findOnPath(names, env) {
  for (const name of names) {
    for (const dir of (env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

// Locate a headless-capable Chrome/Chromium binary on PATH (the server docker
// image ships `chromium`; local dev machines may have `google-chrome`).
export function findChrome(env = process.env) {
  return findOnPath(CHROME_NAMES, env);
}

// poppler's pdfinfo, from the same poppler-utils package that gives the LLM
// CLIs pdftotext.
export function findPdfinfo(env = process.env) {
  return findOnPath(['pdfinfo'], env);
}

// poppler's pdftotext, which turns an acquired manual into the text the
// markdown extraction is built from (services/manualText.js).
export function findPdftotext(env = process.env) {
  return findOnPath(['pdftotext'], env);
}

// A complete PDF ends with an %%EOF marker on its last line; a few writers
// leave trailing whitespace or a stray byte after it, so look at the tail
// rather than the very end.
const EOF_SEARCH_BYTES = 2048;

function readTail(filePath, count) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(count, size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

// Deep validation, used when acquiring a manual: a file can start with %PDF-
// and still be unusable. Some manuals are served truncated — erogenous-tones'
// vc8-instructions.pdf, for one, is cut off at exactly 1MiB, so the header
// survives but the xref table and trailer do not. Everything downstream
// (pdftotext, the LLM CLIs reading the manual, the browser's viewer) fails on
// such a file, so accepting it on its header alone means storing a manual that
// no later job can read. Parsing it here instead lets the acquisition chain
// fall through to the next candidate and ultimately to the product-page
// render. Without poppler on PATH the check degrades to the structural %%EOF
// test rather than rejecting every document.
export async function pdfIsReadable(filePath, opts = {}) {
  const { pdfinfoPath = findPdfinfo(), execImpl = execFile, log = () => {} } = opts;

  const basic = isProbablyPdf(filePath);
  if (!basic.ok) return basic;

  try {
    if (!readTail(filePath, EOF_SEARCH_BYTES).includes('%%EOF')) {
      return { ok: false, reason: 'truncated PDF (no %%EOF marker)' };
    }
  } catch (e) {
    return { ok: false, reason: `exception while checking PDF: ${e.message}` };
  }

  if (!pdfinfoPath) {
    log('no pdfinfo binary on PATH; validating PDFs by structure alone');
    return { ok: true, reason: 'ok' };
  }

  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      execImpl(pdfinfoPath, [filePath], { timeout: 60_000 }, (err, out, errOut) => {
        if (!err) return resolve(String(out || ''));
        // pdfinfo reports the real problem on stderr ("Syntax Error: Couldn't
        // find trailer dictionary"); its own message is just an exit status.
        const detail = String(errOut || '').trim().split('\n')[0] || err.message;
        reject(new Error(detail));
      });
    });
  } catch (e) {
    return { ok: false, reason: `pdfinfo cannot parse the document: ${e.message}` };
  }

  if (!Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1] || 0)) {
    return { ok: false, reason: 'PDF has no pages' };
  }
  return { ok: true, reason: 'ok' };
}

// Save a web page as a PDF using headless Chrome. Returns true when dest is a
// valid PDF afterwards. Chrome's exit status is ignored (like the Python
// original): a timed-out or crashed render may still have produced a usable
// file, so the validation of dest is what decides. find_manuals.py also fell
// back to weasyprint when no Chrome exists; there is no Node equivalent, so
// the docker image guarantees chromium instead.
export async function renderPageToPdf(url, dest, opts = {}) {
  const {
    chromePath = findChrome(),
    execImpl = execFile,
    validateImpl = pdfIsReadable,
    log = () => {},
  } = opts;
  if (!chromePath) {
    log('no chrome/chromium binary found on PATH; cannot render page to PDF');
    return false;
  }
  // Chrome will happily render file:// and internal http:// URLs, so the URL
  // is held to the same SSRF policy as a plain download before it is handed to
  // the browser. Chrome does not re-consult us on redirects, but the starting
  // point at least cannot be pointed at the metadata endpoint or a local file.
  try {
    await assertUrlAllowed(url);
  } catch (e) {
    log(`refusing to render ${url}: ${e.message}`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = [
    '--headless',
    // Chrome's sandbox needs privileges (SUID helper or unprivileged user
    // namespaces) that the server container does not have.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-pdf-header-footer',
    '--virtual-time-budget=15000',
    `--print-to-pdf=${dest}`,
    url,
  ];
  try {
    await new Promise((resolve, reject) => {
      execImpl(chromePath, args, { timeout: 180_000 }, (err) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    log(`headless chrome rendering ${url}: ${e.message}`);
  }
  const { ok, reason } = await validateImpl(dest, { log });
  if (ok) return true;
  log(`rendered ${url} is not a valid PDF (${reason})`);
  fs.rmSync(dest, { force: true });
  return false;
}

// Download url to dest and verify it is a real, readable PDF. Retries once
// with fuller browser headers when the plain user agent is rejected.
export async function downloadPdf(
  url,
  dest,
  { fetchImpl = fetch, validateImpl = pdfIsReadable, log = () => {} } = {}
) {
  let originMatch = url.match(/^https?:\/\/[^/]+/);
  const retryHeaders = { ...CHROME_DESKTOP_HEADERS };
  if (originMatch) retryHeaders.Referer = originMatch[0] + '/';

  const attempts = [
    [{ 'User-Agent': USER_AGENT }, null],
    [retryHeaders, 'retrying with Chrome desktop headers'],
  ];

  for (const [headers, note] of attempts) {
    if (note) log(`${note}: ${url}`);
    try {
      // safeFetch validates the URL and every redirect hop; the write is
      // capped so a hostile endpoint cannot fill the manuals volume.
      const res = await safeFetch(url, { fetchImpl, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
        throw new Error(`declared length ${declared} exceeds ${MAX_PDF_BYTES} byte limit`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (res.body && typeof res.body.getReader === 'function') {
        let written = 0;
        await pipeline(
          Readable.fromWeb(res.body),
          async function* (source) {
            for await (const chunk of source) {
              written += chunk.length;
              if (written > MAX_PDF_BYTES) {
                throw new Error(`body exceeds ${MAX_PDF_BYTES} byte limit`);
              }
              yield chunk;
            }
          },
          fs.createWriteStream(dest)
        );
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_PDF_BYTES) throw new Error(`body exceeds ${MAX_PDF_BYTES} byte limit`);
        fs.writeFileSync(dest, buf);
      }
    } catch (e) {
      if (e instanceof BlockedUrlError) log(`download blocked: ${url}: ${e.message}`);
      else log(`download failed: ${url}: ${e.message}`);
      fs.rmSync(dest, { force: true });
      continue;
    }

    const { ok, reason } = await validateImpl(dest, { log });
    if (ok) return true;
    log(`${url} is not a valid PDF (${reason})`);
    fs.rmSync(dest, { force: true });
  }
  return false;
}
