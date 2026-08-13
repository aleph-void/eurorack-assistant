// Manual discovery, ported from eurorack-processor's find_manuals.py:
// LLM web research for the official manual PDF, then the script's fallback
// chain — direct download with validation, Wayback Machine snapshots of dead
// manual URLs, the product page rendered to PDF with headless Chrome, the
// archive.org item library, and finally a Wayback snapshot of the product
// page rendered to PDF.

import fs from 'node:fs';
import path from 'node:path';
import { Op, fn, col, where } from 'sequelize';
import { extractJsonObject } from './json.js';
import {
  downloadPdf,
  manualPath,
  renderPageToPdf,
  safeManualName,
  sha256File,
  USER_AGENT,
} from './pdf.js';

export const RESEARCH_TEMPLATE = (line) => `You are researching the eurorack modular synthesizer module: "${line}"

Task: find the OFFICIAL user manual PDF for this module on the internet.

1. Determine the manufacturer name and the module name.
2. Search the web for the manufacturer's official manual PDF for this module.
   Direct links to .pdf files on the manufacturer's own site are strongly
   preferred. PDFs hosted by reputable sources (retailers who sell the module,
   ModWiggler attachments) are acceptable if no official link exists. Do not
   use rack-planning sites such as ModularGrid as a source.
3. Also find the module's public product web page: the manufacturer's own page
   for it, or failing that a retailer's product page.

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

// Return the closest Wayback Machine snapshot URL for a page, if any.
export async function waybackSnapshotUrl(url, { fetchImpl = fetch, log = () => {} } = {}) {
  try {
    const params = new URLSearchParams({ url });
    const res = await fetchImpl(`https://archive.org/wayback/available?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const closest = (await res.json()).archived_snapshots?.closest || {};
    if (closest.available && closest.url) return closest.url;
  } catch (e) {
    log(`wayback lookup failed for ${url}: ${e.message}`);
  }
  return null;
}

// Try, in order: direct PDF download, Wayback snapshots of dead manual URLs,
// product page rendered to PDF, archive.org item library, Wayback snapshot of
// the product page rendered to PDF — the acquisition chain of find_manuals.py
// plus the dead-URL recovery step. The result lands in a temporary file that is
// then content-addressed: renamed to <sha256>.pdf, so a manual that was
// already retrieved (for this or any other module) reuses the existing file.
// Returns { hash, kind } with kind 'manual' (a real PDF manual) or
// 'product_page' (a rendered stand-in), or null if every step failed.
export async function acquireManual(info, manualsDir, deps = {}) {
  const { fetchImpl = fetch, log = () => {}, renderImpl = renderPageToPdf } = deps;
  const tmp = path.join(manualsDir, `download_${safeManualName(info.manufacturer, info.module)}`);

  let kind = null;

  // 1. Direct PDF manual
  for (const url of info.pdf_urls) {
    log(`trying manual PDF: ${url}`);
    if (await downloadPdf(url, tmp, { fetchImpl, log })) {
      kind = 'manual';
      break;
    }
  }

  // 1b. Wayback snapshots of the failed manual URLs — a manufacturer's site
  // may be gone while its manual PDF lives on in the Wayback Machine (e.g.
  // web.archive.org/web/<ts>/https://www.iolabs.co.uk/...pdf). Still the real
  // manual, so this beats settling for a product-page render.
  if (!kind) {
    for (const url of info.pdf_urls) {
      const snapshot = await waybackSnapshotUrl(url, { fetchImpl, log });
      if (!snapshot) continue;
      log(`trying wayback snapshot of manual PDF: ${snapshot}`);
      if (await downloadPdf(snapshot, tmp, { fetchImpl, log })) {
        kind = 'manual';
        break;
      }
    }
  }

  // 2. Product page saved as PDF
  if (!kind && info.product_page_url) {
    log(`no PDF manual; rendering product page: ${info.product_page_url}`);
    if (await renderImpl(info.product_page_url, tmp, { log })) kind = 'product_page';
  }

  // 3a. archive.org item library
  if (!kind) {
    log(`searching archive.org for: ${info.manufacturer} ${info.module}`);
    const query = `"${info.manufacturer}" "${info.module}" manual`;
    if (await archiveOrgItemPdf(query, tmp, { fetchImpl, log })) kind = 'manual';
  }

  // 3b. Wayback Machine snapshot of the product page
  if (!kind && info.product_page_url) {
    const snapshot = await waybackSnapshotUrl(info.product_page_url, { fetchImpl, log });
    if (snapshot) {
      log(`rendering wayback snapshot: ${snapshot}`);
      if (await renderImpl(snapshot, tmp, { log })) kind = 'product_page';
    }
  }

  if (!kind) return null;

  const hash = sha256File(tmp);
  const dest = manualPath(manualsDir, hash);
  if (fs.existsSync(dest)) fs.rmSync(tmp, { force: true });
  else fs.renameSync(tmp, dest);
  return { hash, kind };
}

// Full pipeline for one module row: research, download, update the module
// record. Always retrieves from the internet; the hash dedupe in
// acquireManual/the manuals table makes a re-run of an unchanged manual a
// no-op.
export async function findManualForModule(db, backend, module, manualsDir, deps = {}) {
  const { fetchImpl = fetch, log = () => {}, renderImpl = renderPageToPdf } = deps;
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

  const { Module, Manual } = db.models;

  // Keep the caller's naming when it was given explicitly.
  if (module.manufacturer) {
    info.manufacturer = module.manufacturer;
    info.module = module.name;
  } else if (info.manufacturer) {
    // Free-text import: adopt the researched official naming — unless another
    // module already uses it (modules are shared records), in which case the
    // original free-text naming is kept to avoid a collision.
    const clash = await Module.findOne({
      where: {
        [Op.and]: [
          where(fn('lower', col('manufacturer')), info.manufacturer.toLowerCase()),
          where(fn('lower', col('name')), info.module.toLowerCase()),
          { id: { [Op.ne]: module.id } },
        ],
      },
    });
    if (!clash) {
      await Module.update(
        { manufacturer: info.manufacturer, name: info.module },
        { where: { id: module.id } }
      );
    } else {
      log(`researched name "${info.manufacturer} ${info.module}" already exists; keeping "${module.name}"`);
    }
  }

  const acquired = await acquireManual(info, manualsDir, { fetchImpl, log, renderImpl });
  if (acquired) {
    const { hash, kind } = acquired;
    const originalName = safeManualName(
      info.manufacturer,
      info.module,
      kind === 'product_page' ? 'Product_Page' : 'Manual'
    );
    // A rendered product page produces different bytes on every run, so the
    // content-hash dedupe that makes re-runs a no-op for real manuals cannot
    // collapse renders. Instead, any earlier rendered stand-in for this module
    // (recognized by its _Product_Page.pdf name) with different content is
    // superseded by this acquisition — a fresh render, or a real manual that
    // has since turned up.
    const staleRenders = await Manual.findAll({
      where: {
        module_id: module.id,
        user_id: null,
        original_name: { [Op.like]: '%_Product_Page.pdf' },
        hash: { [Op.ne]: hash },
      },
    });
    // Recording the document and flipping the module's status commit
    // together. A document with this content already recorded for the module
    // is referenced instead of duplicated.
    await db.sequelize.transaction(async (transaction) => {
      if (staleRenders.length > 0) {
        await Manual.destroy({
          where: { id: staleRenders.map((m) => m.id) },
          transaction,
        });
      }
      const existing = await Manual.findOne({
        where: { module_id: module.id, user_id: null, hash },
        transaction,
      });
      if (!existing) {
        await Manual.create(
          {
            module_id: module.id,
            user_id: null,
            hash,
            original_name: originalName,
            source: 'found',
          },
          { transaction }
        );
      }
      await Module.update(
        { manual_status: 'found' },
        { where: { id: module.id }, transaction }
      );
    });
    // Manual files are content-addressed and shared by every record with the
    // same hash; a superseded render's file is removed only once its last
    // database reference is gone.
    for (const staleHash of new Set(staleRenders.map((m) => m.hash))) {
      if ((await Manual.count({ where: { hash: staleHash } })) === 0) {
        fs.rmSync(manualPath(manualsDir, staleHash), { force: true });
      }
    }
    return hash;
  }
  await Module.update({ manual_status: 'failed' }, { where: { id: module.id } });
  return null;
}
