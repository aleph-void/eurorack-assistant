// Manual discovery, ported from eurorack-processor's find_manuals.py:
// LLM web research for the official manual PDF, direct download with
// validation, then an archive.org item-library fallback.

import path from 'node:path';
import { extractJsonObject } from './json.js';
import { downloadPdf, isProbablyPdf, safeManualName, USER_AGENT } from './pdf.js';

export const RESEARCH_TEMPLATE = (line) => `You are researching the eurorack modular synthesizer module: "${line}"

Task: find the OFFICIAL user manual PDF for this module on the internet.

1. Determine the manufacturer name and the module name.
2. Search the web for the manufacturer's official manual PDF for this module.
   Direct links to .pdf files on the manufacturer's own site are strongly
   preferred. PDFs hosted by reputable sources (ModularGrid, retailers,
   ModWiggler attachments) are acceptable if no official link exists.
3. Also find the module's product web page (manufacturer page preferred,
   otherwise its ModularGrid page).

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{"manufacturer": "...", "module": "...", "pdf_urls": ["https://..."], "product_page_url": "https://..."}

Rules:
- "pdf_urls": up to 3 candidate direct-download PDF URLs, best first.
  Use [] if you cannot find any PDF manual.
- "product_page_url": use null if you cannot find a product page.
- Use the manufacturer's and module's official spelling/capitalization.
`;

export async function researchModule(backend, line) {
  const response = await backend.completeTextWithSearch(RESEARCH_TEMPLATE(line));
  const info = extractJsonObject(response);
  if (!Array.isArray(info.pdf_urls)) info.pdf_urls = info.pdf_urls ? [info.pdf_urls] : [];
  info.manufacturer = String(info.manufacturer || '').trim();
  info.module = String(info.module || '').trim();
  info.product_page_url = info.product_page_url ? String(info.product_page_url).trim() : null;
  if (!info.manufacturer || !info.module) {
    throw new Error(`LLM response missing manufacturer/module: ${JSON.stringify(info)}`);
  }
  return info;
}

// Search the archive.org item library for a PDF matching the query.
export async function archiveOrgItemPdf(query, dest, { fetchImpl = fetch, log = () => {} } = {}) {
  let docs;
  try {
    const params = new URLSearchParams({
      q: `(${query}) AND mediatype:(texts)`,
      'fl[]': 'identifier',
      rows: '5',
      page: '1',
      output: 'json',
    });
    const res = await fetchImpl(`https://archive.org/advancedsearch.php?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    docs = (await res.json()).response?.docs || [];
  } catch (e) {
    log(`archive.org search failed: ${e.message}`);
    return false;
  }

  for (const doc of docs) {
    if (!doc.identifier) continue;
    let meta;
    try {
      const res = await fetchImpl(`https://archive.org/metadata/${doc.identifier}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      meta = await res.json();
    } catch {
      continue;
    }
    for (const f of meta.files || []) {
      const name = f.name || '';
      if (name.toLowerCase().endsWith('.pdf')) {
        const url = `https://archive.org/download/${doc.identifier}/${encodeURIComponent(name)}`;
        log(`trying archive.org item: ${url}`);
        if (await downloadPdf(url, dest, { fetchImpl, log })) return true;
      }
    }
  }
  return false;
}

// Try, in order: direct PDF download, archive.org item library.
// Returns the manual file name (inside manualsDir), or null if all failed.
export async function acquireManual(info, manualsDir, { fetchImpl = fetch, log = () => {} } = {}) {
  const manualName = safeManualName(info.manufacturer, info.module);
  const dest = path.join(manualsDir, manualName);

  if (isProbablyPdf(dest).ok) {
    log(`already downloaded: ${manualName}`);
    return manualName;
  }
  for (const url of info.pdf_urls) {
    log(`trying manual PDF: ${url}`);
    if (await downloadPdf(url, dest, { fetchImpl, log })) return manualName;
  }

  log(`searching archive.org for: ${info.manufacturer} ${info.module}`);
  const query = `"${info.manufacturer}" "${info.module}" manual`;
  if (await archiveOrgItemPdf(query, dest, { fetchImpl, log })) return manualName;

  return null;
}

// Full pipeline for one module row: research (unless the manufacturer/name are
// already known and a manual exists), download, update the module record.
export async function findManualForModule(db, backend, module, manualsDir, deps = {}) {
  const { fetchImpl = fetch, log = () => {} } = deps;
  const line = module.manufacturer ? `${module.manufacturer},${module.name}` : module.name;

  let info;
  try {
    info = await researchModule(backend, line);
  } catch (e) {
    if (!module.manufacturer) throw e;
    // The manufacturer/module names are already known, so the archive.org
    // fallback can still run without the LLM.
    log(`LLM research failed (${e.message}); trying archive.org with the known name`);
    info = {
      manufacturer: module.manufacturer,
      module: module.name,
      pdf_urls: [],
      product_page_url: null,
    };
  }

  // Keep the caller's naming when it was given explicitly.
  if (module.manufacturer) {
    info.manufacturer = module.manufacturer;
    info.module = module.name;
  } else if (info.manufacturer) {
    // Free-text import: adopt the researched official naming — unless another
    // module already uses it (modules are shared records), in which case the
    // original free-text naming is kept to avoid a collision.
    const { rows: clash } = await db.query(
      `SELECT id FROM modules
       WHERE lower(manufacturer) = lower($2) AND lower(name) = lower($3) AND id <> $1`,
      [module.id, info.manufacturer, info.module]
    );
    if (clash.length === 0) {
      await db.query(
        'UPDATE modules SET manufacturer = $2, name = $3, updated_at = now() WHERE id = $1',
        [module.id, info.manufacturer, info.module]
      );
    } else {
      log(`researched name "${info.manufacturer} ${info.module}" already exists; keeping "${module.name}"`);
    }
  }

  const manualName = await acquireManual(info, manualsDir, { fetchImpl, log });
  if (manualName) {
    // Record the shared (user_id NULL) manual document unless already present.
    const { rows: existing } = await db.query(
      'SELECT id FROM manuals WHERE module_id = $1 AND user_id IS NULL AND filename = $2',
      [module.id, manualName]
    );
    if (existing.length === 0) {
      await db.query(
        `INSERT INTO manuals (module_id, user_id, filename, source) VALUES ($1, NULL, $2, 'found')`,
        [module.id, manualName]
      );
    }
    await db.query(
      `UPDATE modules SET manual_status = 'found', updated_at = now() WHERE id = $1`,
      [module.id]
    );
    return manualName;
  }
  await db.query(
    `UPDATE modules SET manual_status = 'failed', updated_at = now() WHERE id = $1`,
    [module.id]
  );
  return null;
}
