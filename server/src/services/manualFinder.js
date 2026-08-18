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
4. Independently find the page for this exact module on perfectcircuit.com.
   This retailer often has a useful jack-by-jack feature description even when
   the manufacturer has not published a manual.
5. Independently find the module's BUILD DOCUMENT: the assembly guide, build
   guide, build instructions, construction manual or DIY kit documentation.
   Open-source and DIY modules (Music Thing, Befaco, Nonlinearcircuits,
   Thonk/Erica kits, Mutable clones, PCB+panel releases) usually publish one
   even when they publish no user manual, and it names and describes the
   panel's jacks and controls. Direct .pdf links are required — a build page
   in HTML, a GitHub repository page or a wiki does not count. Kit-seller
   documentation pages (Thonk, Modular Addict) are acceptable sources.

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{"manufacturer": "...", "module": "...", "pdf_urls": ["https://..."], "product_page_url": "https://...", "perfect_circuit_url": "https://www.perfectcircuit.com/...", "build_doc_urls": ["https://..."]}

Rules:
- "pdf_urls": up to 3 candidate direct-download PDF URLs, best first.
  Use [] if you cannot find any PDF manual.
- "product_page_url": use null if you cannot find a product page.
- "perfect_circuit_url": use the matching product page on perfectcircuit.com
  only. Verify that both manufacturer and module match; use null if Perfect
  Circuit has no page for it. Do not return a search-results or category URL.
- "build_doc_urls": up to 2 candidate direct-download PDF URLs for the build
  document, best first. Verify that both manufacturer and module match. Use []
  if this module has no published build document — most commercial closed-
  source modules do not, and a guess is worse than nothing.
- Use the manufacturer's and module's official spelling/capitalization.
`;

export async function researchModule(backend, line) {
  const response = await backend.completeTextWithSearch(RESEARCH_TEMPLATE(line));
  const info = extractJsonObject(response);
  if (!Array.isArray(info.pdf_urls)) info.pdf_urls = info.pdf_urls ? [info.pdf_urls] : [];
  info.manufacturer = String(info.manufacturer || '').trim();
  info.module = String(info.module || '').trim();
  info.product_page_url = info.product_page_url ? String(info.product_page_url).trim() : null;
  info.perfect_circuit_url = normalizePerfectCircuitUrl(info.perfect_circuit_url);
  if (!Array.isArray(info.build_doc_urls)) {
    info.build_doc_urls = info.build_doc_urls ? [info.build_doc_urls] : [];
  }
  info.build_doc_urls = info.build_doc_urls.map((u) => String(u).trim()).filter(Boolean);
  if (!info.manufacturer || !info.module) {
    throw new Error(`LLM response missing manufacturer/module: ${JSON.stringify(info)}`);
  }
  return info;
}

// A retailer product page URL is only usable when it really is a page on
// that retailer's site — the LLM is prone to inventing plausible paths on
// the right domain, which the render step then discovers, but a wrong
// domain or a bare homepage is knowably useless up front.
export function normalizeRetailerUrl(value, retailerHost) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.protocol !== 'https:' || host !== retailerHost || url.pathname === '/') {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export const normalizePerfectCircuitUrl = (value) =>
  normalizeRetailerUrl(value, 'perfectcircuit.com');

// The name suffixes of the two kinds of companion document. They are how the
// analyze_manual job recognizes one later, so they are exported rather than
// spelled out again there.
export const PERFECT_CIRCUIT_SUFFIX = 'Perfect_Circuit_Product_Page';
export const BUILD_DOCUMENT_SUFFIX = 'Build_Document';
export const DETROIT_MODULAR_SUFFIX = 'Detroit_Modular_Product_Page';
export const MIDWEST_MODULAR_SUFFIX = 'Midwest_Modular_Product_Page';

// The retailers whose product pages the component re-analysis fetches: each
// tends to describe a module's panel jack by jack. `key` names the URL field
// in the research response, `suffix` the saved document.
export const RETAILER_PAGES = [
  {
    host: 'perfectcircuit.com',
    label: 'Perfect Circuit',
    key: 'perfect_circuit_url',
    suffix: PERFECT_CIRCUIT_SUFFIX,
  },
  {
    host: 'detroitmodular.com',
    label: 'Detroit Modular',
    key: 'detroit_modular_url',
    suffix: DETROIT_MODULAR_SUFFIX,
  },
  {
    host: 'midwestmodular.com',
    label: 'Midwest Modular',
    key: 'midwest_modular_url',
    suffix: MIDWEST_MODULAR_SUFFIX,
  },
];

export const RETAILER_PAGE_SUFFIXES = RETAILER_PAGES.map((r) => r.suffix);

const nameHasSuffix = (name, suffix) => new RegExp(`_${suffix}\\.pdf$`, 'i').test(name || '');

// A saved retailer product-page render, recognized by the name the fetch
// gave it. Both the route that refuses to fetch pages that already exist and
// the button in the GUI test for this.
export const isRetailerPageName = (name) =>
  RETAILER_PAGE_SUFFIXES.some((suffix) => nameHasSuffix(name, suffix));

// Any auto-found document that is only ever submitted ALONGSIDE the module's
// manual, never analyzed as the manual itself.
export const isCompanionDocumentName = (name) =>
  isRetailerPageName(name) || nameHasSuffix(name, BUILD_DOCUMENT_SUFFIX);

export const RETAILER_RESEARCH_TEMPLATE = (line) => `You are researching the eurorack modular synthesizer module: "${line}"

Task: find this exact module's product page on each of these three retailers.

1. perfectcircuit.com
2. detroitmodular.com
3. midwestmodular.com

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{"perfect_circuit_url": "https://www.perfectcircuit.com/...", "detroit_modular_url": "https://detroitmodular.com/...", "midwest_modular_url": "https://midwestmodular.com/..."}

Rules:
- Each URL must be the product page for this exact module on that retailer's
  site: verify that both manufacturer and module match. Do not return a
  search-results, category or homepage URL.
- Use null for any retailer that has no page for this module. A guess is
  worse than nothing.
`;

// The three retailer product page URLs, keyed by retailer host. Only URLs
// actually on the retailer's site survive normalization.
export async function researchRetailerPages(backend, line) {
  const response = await backend.completeTextWithSearch(RETAILER_RESEARCH_TEMPLATE(line));
  const info = extractJsonObject(response);
  const urls = new Map();
  for (const retailer of RETAILER_PAGES) {
    const url = normalizeRetailerUrl(info[retailer.key], retailer.host);
    if (url) urls.set(retailer.host, url);
  }
  return urls;
}

// Fetch the module's product page from each retailer that has one and record
// every render as a shared document. Returns the plain manual rows of the
// pages saved this run. Callers refuse to run when any retailer page already
// exists for the module, so this never has stale renders of its own kind to
// supersede.
export async function fetchRetailerPagesForModule(db, backend, module, manualsDir, deps = {}) {
  const { log = () => {}, renderImpl = renderPageToPdf } = deps;
  const line = module.manufacturer ? `${module.manufacturer},${module.name}` : module.name;
  let urls;
  try {
    urls = await researchRetailerPages(backend, line);
  } catch (e) {
    log(`retailer page research failed: ${e.message}`);
    return [];
  }
  const { Manual } = db.models;
  const saved = [];
  for (const retailer of RETAILER_PAGES) {
    const url = urls.get(retailer.host);
    if (!url) {
      log(`no ${retailer.label} page found`);
      continue;
    }
    const originalName = safeManualName(module.manufacturer, module.name, retailer.suffix);
    const tmp = path.join(manualsDir, `download_${originalName}`);
    log(`rendering ${retailer.label} product page: ${url}`);
    if (!(await renderImpl(url, tmp, { log }))) {
      log(`${retailer.label} page did not render`);
      continue;
    }
    const hash = storeAcquired(tmp, manualsDir);
    const row = await db.sequelize.transaction(async (transaction) => {
      const existing = await Manual.findOne({
        where: { module_id: module.id, user_id: null, hash },
        transaction,
      });
      if (existing) return existing;
      return Manual.create(
        {
          module_id: module.id,
          user_id: null,
          hash,
          original_name: originalName,
          source: 'found',
        },
        { transaction }
      );
    });
    saved.push(row.get({ plain: true }));
  }
  return saved;
}

// Move a freshly acquired temporary file into the content-addressed store.
function storeAcquired(tmp, manualsDir) {
  const hash = sha256File(tmp);
  const dest = manualPath(manualsDir, hash);
  if (fs.existsSync(dest)) fs.rmSync(tmp, { force: true });
  else fs.renameSync(tmp, dest);
  return hash;
}

// An open-source module's build document: the assembly guide a DIY module
// ships instead of a user manual. It names and describes the same panel, and
// unlike a rendered page it is a real PDF, so the content hash makes a re-run
// a no-op. Direct download first, then the Wayback Machine for a build guide
// whose host has since gone (small makers' sites do).
export async function acquireBuildDocument(info, manualsDir, deps = {}) {
  const { fetchImpl = fetch, log = () => {} } = deps;
  const urls = info.build_doc_urls || [];
  if (!urls.length) return null;
  const originalName = safeManualName(info.manufacturer, info.module, BUILD_DOCUMENT_SUFFIX);
  const tmp = path.join(manualsDir, `download_${originalName}`);

  for (const url of urls) {
    log(`trying build document: ${url}`);
    if (await downloadPdf(url, tmp, { fetchImpl, log })) {
      return { hash: storeAcquired(tmp, manualsDir), originalName, kind: 'build_doc' };
    }
  }
  for (const url of urls) {
    const snapshot = await waybackSnapshotUrl(url, { fetchImpl, log });
    if (!snapshot) continue;
    log(`trying wayback snapshot of build document: ${snapshot}`);
    if (await downloadPdf(snapshot, tmp, { fetchImpl, log })) {
      return { hash: storeAcquired(tmp, manualsDir), originalName, kind: 'build_doc' };
    }
  }
  log('no build document could be downloaded');
  return null;
}

// The second document submitted alongside a rendered product page, because one
// retailer's or maker's page rarely tours the panel on its own.
//
// Perfect Circuit's listing is the first choice: it reads jack by jack. When
// there is no listing there — nobody stocks the module, or it is a DIY kit
// rather than a finished product — the module is exactly the sort that has a
// build document instead, so that is what is fetched. A Perfect Circuit page
// that fails to render falls through to the same place.
async function acquireCompanionDocument(info, manualsDir, deps = {}) {
  const { log = () => {}, renderImpl = renderPageToPdf, fetchImpl = fetch } = deps;
  const url = normalizePerfectCircuitUrl(info.perfect_circuit_url);
  let primaryIsPerfectCircuit = false;
  try {
    primaryIsPerfectCircuit =
      new URL(info.product_page_url).hostname.toLowerCase().replace(/^www\./, '') ===
      'perfectcircuit.com';
  } catch {
    // A missing/invalid primary URL is handled by the normal acquisition path.
  }
  if (url && !primaryIsPerfectCircuit) {
    const originalName = safeManualName(info.manufacturer, info.module, PERFECT_CIRCUIT_SUFFIX);
    const tmp = path.join(manualsDir, `download_${originalName}`);
    log(`rendering companion Perfect Circuit product page: ${url}`);
    if (await renderImpl(url, tmp, { log })) {
      return { hash: storeAcquired(tmp, manualsDir), originalName, kind: 'perfect_circuit' };
    }
    log('Perfect Circuit page did not render; looking for a build document instead');
  } else {
    log('no separate Perfect Circuit listing; looking for a build document instead');
  }
  return acquireBuildDocument(info, manualsDir, { fetchImpl, log });
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
      perfect_circuit_url: null,
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
    const companion =
      kind === 'product_page'
        ? await acquireCompanionDocument(info, manualsDir, { log, renderImpl, fetchImpl })
        : null;
    // A rendered product page produces different bytes on every run, so the
    // content-hash dedupe that makes re-runs a no-op for real manuals cannot
    // collapse renders. Instead, any earlier auto-acquired stand-in for this
    // module (recognized by its _Product_Page.pdf or _Build_Document.pdf name)
    // with different content is superseded by this acquisition — a fresh
    // render, or a real manual that has since turned up.
    const previousRenders = await Manual.findAll({
      where: {
        module_id: module.id,
        user_id: null,
        [Op.or]: [
          { original_name: { [Op.like]: '%_Product_Page.pdf' } },
          { original_name: { [Op.like]: `%_${BUILD_DOCUMENT_SUFFIX}.pdf` } },
        ],
      },
    });
    const currentHashes = new Set([hash, companion?.hash].filter(Boolean));
    const staleRenders = previousRenders.filter((m) => {
      if (currentHashes.has(m.hash)) return false;
      if (kind === 'manual') return true;
      if (m.original_name === originalName) return true;
      return companion && m.original_name === companion.originalName;
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
      if (companion) {
        const existingCompanion = await Manual.findOne({
          where: { module_id: module.id, user_id: null, hash: companion.hash },
          transaction,
        });
        if (!existingCompanion) {
          await Manual.create(
            {
              module_id: module.id,
              user_id: null,
              hash: companion.hash,
              original_name: companion.originalName,
              source: 'found',
            },
            { transaction }
          );
        }
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
