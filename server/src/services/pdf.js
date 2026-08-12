import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

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

// Locate a headless-capable Chrome/Chromium binary on PATH (the server docker
// image ships `chromium`; local dev machines may have `google-chrome`).
export function findChrome(env = process.env) {
  for (const name of CHROME_NAMES) {
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

// Save a web page as a PDF using headless Chrome. Returns true when dest is a
// valid PDF afterwards. Chrome's exit status is ignored (like the Python
// original): a timed-out or crashed render may still have produced a usable
// file, so the validation of dest is what decides. find_manuals.py also fell
// back to weasyprint when no Chrome exists; there is no Node equivalent, so
// the docker image guarantees chromium instead.
export async function renderPageToPdf(url, dest, opts = {}) {
  const { chromePath = findChrome(), execImpl = execFile, log = () => {} } = opts;
  if (!chromePath) {
    log('no chrome/chromium binary found on PATH; cannot render page to PDF');
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
  const { ok, reason } = isProbablyPdf(dest);
  if (ok) return true;
  log(`rendered ${url} is not a valid PDF (${reason})`);
  fs.rmSync(dest, { force: true });
  return false;
}

// Download url to dest and verify it is a real PDF. Retries once with fuller
// browser headers when the plain user agent is rejected.
export async function downloadPdf(url, dest, { fetchImpl = fetch, log = () => {} } = {}) {
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
      const res = await fetchImpl(url, { headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (res.body && typeof res.body.getReader === 'function') {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(dest, buf);
      }
    } catch (e) {
      log(`download failed: ${url}: ${e.message}`);
      fs.rmSync(dest, { force: true });
      continue;
    }

    const { ok, reason } = isProbablyPdf(dest);
    if (ok) return true;
    log(`${url} is not a valid PDF (${reason})`);
    fs.rmSync(dest, { force: true });
  }
  return false;
}
