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

export function safeManualName(manufacturer, module, suffix = 'Manual') {
  const base = `${manufacturer}_${module}_${suffix}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base}.pdf`;
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
