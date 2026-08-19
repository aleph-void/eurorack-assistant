// Per-job-type handlers for the queue worker. Each handler receives
// (job, backend, progress) and does the actual work of one job type:
//   import          — parse an import (text/csv/modulargrid), create module
//                     records, and queue a find_manual job per new module
//   find_manual     — research + download the module's manual PDF, then queue
//                     analyze_manual and extract_manual jobs for it
//   analyze_manual  — LLM analysis of the manual into a summary + components,
//                     then queue a panel_image job for it
//   extract_manual  — pdftotext + markdown structuring of one document, stored
//                     for reading and full-text search. No LLM involved unless
//                     the PDF turns out to have no text layer at all, which
//                     only a model can read
//   panel_image     — find (or draw) the module's front panel and place every
//                     analyzed component on it
//   download_video  — yt-dlp an attached YouTube video, sample frames and
//                     pull the caption track, delete the video file, then
//                     queue analyze_video. No LLM involved
//   analyze_video   — LLM summary of the techniques the video demonstrates,
//                     written to the video row; the frames and transcript are
//                     deleted once it lands
//   reanalyze_components — fetch the module's product page from the retailers
//                     that describe panels jack by jack (Perfect Circuit,
//                     Detroit Modular, Midwest Modular), then re-run the
//                     manual analysis with every page that was found attached
//   describe_components — write descriptions for components that have none
//                     (added by hand after the import) from the module's
//                     documents, touching nothing that is already described
//   scope_question  — determine which modules/jacks a question applies to,
//                     then leave the question 'scoped' for the user to review
//   answer_question — ask the LLM with the reviewed scope and attachments
//   export_rack     — zip a rack's manuals, notes and questions into a
//                     one-shot download served by the exports route
//
// The queue mechanics (claiming, leases, retries, pauses) live in worker.js.

import { manualPath, renderPageToPdf } from '../services/pdf.js';
import {
  parseModuleCsv,
  parseModuleLines,
  fetchModulargridRack,
  importModules,
} from '../services/importer.js';
import {
  findManualForModule,
  fetchRetailerPagesForModule,
  isCompanionDocumentName,
  isRetailerPageName,
} from '../services/manualFinder.js';
import { analyzeManualForModule } from '../services/manualAnalyzer.js';
import {
  describeComponentsForModule,
  moduleFactGaps,
} from '../services/componentDescriber.js';
import { extractManualDocument } from '../services/manualText.js';
import { buildPanelForModule } from '../services/panelImage.js';
import { downloadVideoForModule, removeVideoFiles } from '../services/videos.js';
import { analyzeVideoForModule } from '../services/videoAnalyzer.js';
import { answerQuestion, scopeQuestion } from '../services/ask.js';
import { safeSegment, writeRackExport } from '../services/rackExport.js';
import { enqueueExtractManual, enqueueFindManual, enqueueJob, enqueueModuleJob, enqueueVideoJob } from './enqueue.js';

// User uploads have a free-form display name and retain their original file
// name. Accept either spelling style people naturally use for a saved
// Perfect Circuit page ("Perfect Circuit", "Perfect_Circuit", or a hyphen).
export function isPerfectCircuitDocument(document) {
  const label = `${document?.name || ''} ${document?.original_name || ''}`;
  return /(?:^|[^a-z])perfect[\s_-]*circuit(?:[^a-z]|$)/i.test(label);
}

// The same, for the build document an open-source module publishes in place
// of a manual — whatever the uploader called it ("build doc", "Build Guide",
// "assembly instructions", "BOM and build").
export function isBuildDocument(document) {
  const label = `${document?.name || ''} ${document?.original_name || ''}`;
  return /(?:^|[^a-z])(build|assembly)(?:[^a-z]|$)/i.test(label);
}

export function createHandlers(
  db,
  {
    manualsDir,
    exportsDir,
    capturesDir,
    panelsDir,
    videosDir,
    fetchImpl = fetch,
    renderImpl = renderPageToPdf,
    extractImpl = extractManualDocument,
    downloadVideoImpl = downloadVideoForModule,
    analyzeVideoImpl = analyzeVideoForModule,
  }
) {
  async function handleImport(job, backend, progress) {
    const payload = JSON.parse(job.payload || '{}');
    let items;
    if (payload.type === 'csv') {
      items = parseModuleCsv(payload.content || '');
    } else if (payload.type === 'text') {
      items = parseModuleLines(payload.content || '');
    } else if (payload.type === 'modulargrid') {
      progress(`fetching ModularGrid rack: ${payload.url}`);
      items = await fetchModulargridRack(payload.url, { fetchImpl });
    } else {
      throw new Error(`Unknown import type: ${payload.type}`);
    }
    if (items.length === 0) throw new Error('No modules found in the input');

    progress(`importing ${items.length} module(s)`);
    const { rack, results } = await importModules(db, job.user_id, payload.rack, items);
    progress(`importing into rack '${rack.name}'`);
    let queued = 0;
    for (const { module, created, added } of results) {
      const verb = created ? 'created' : added ? `added to '${rack.name}'` : 'updated';
      progress(`${verb}: ${module.manufacturer} ${module.name}`.trim());
      if (await enqueueFindManual(db, module, job.user_id)) queued += 1;
    }
    progress(`queued ${queued} manual search job(s)`);
  }

  async function handleFindManual(job, backend, progress) {
    const { Module } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });

    await Module.update({ manual_status: 'searching' }, { where: { id: module.id } });
    progress(`searching for manual: ${module.manufacturer} ${module.name}`.trim());
    const hash = await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      renderImpl,
      log: progress,
    });
    if (!hash) {
      throw new Error(`No manual PDF found for ${module.manufacturer} ${module.name}`);
    }
    progress(`manual saved: ${hash}.pdf`);

    // Chain the analysis job once the manual is on disk — unless the module
    // already has components. Those can only have been built by hand (there
    // was no manual to analyze until now), and a full analysis would destroy
    // them; the narrow description pass reads the new manual and fills in
    // only what is blank instead.
    const components = await db.models.ModuleComponent.count({
      where: { module_id: module.id },
    });
    if (components === 0) {
      const pending = await db.models.Job.findOne({
        where: { module_id: module.id, type: 'analyze_manual', status: ['pending', 'running'] },
      });
      if (!pending) {
        // The analysis job inherits the owner of the find job that chained it.
        await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: job.user_id });
        progress('queued manual analysis');
      }
    } else if (await enqueueModuleJob(db, 'describe_components', module, job.user_id)) {
      progress('components already exist by hand; queued the description pass instead of a full analysis');
    }

    // The searchable text of the document that was just saved. Independent of
    // the analysis — it needs no model and reads nothing the analysis writes —
    // so the two run alongside each other rather than in a chain.
    const saved = await db.models.Manual.findAll({
      where: { module_id: module.id, user_id: null },
      order: [['id', 'ASC']],
    });
    for (const document of saved) {
      const extracted = await db.models.ManualDocument.findOne({
        where: { manual_id: document.id },
      });
      if (!extracted && (await enqueueExtractManual(db, document, job.user_id))) {
        progress(`queued text extraction: ${document.original_name || `${document.hash}.pdf`}`);
      }
    }
  }

  // Turn one document into the markdown that the search index and the reader
  // are built on. payload.manual_id names the document; without one this is
  // the module's shared manual.
  async function handleExtractManual(job, backend, progress) {
    const { Module, Manual } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });
    const payload = JSON.parse(job.payload || '{}');
    const manual = payload.manual_id
      ? await Manual.findOne({ where: { id: payload.manual_id, module_id: module.id } })
      : await Manual.findOne({
          where: { module_id: module.id, user_id: null },
          order: [['id', 'ASC']],
        });
    if (!manual) {
      throw new Error(
        `Module ${module.manufacturer} ${module.name} has no document to extract text from`
      );
    }
    progress(`extracting text: ${manual.original_name || `${manual.hash}.pdf`}`);
    const document = await extractImpl(
      db,
      manual.get({ plain: true }),
      module,
      manualPath(manualsDir, manual.hash),
      // The backend is the fallback, not the method: it is asked only if
      // pdftotext reads nothing out of the file (services/manualText.js).
      { log: progress, backend }
    );
    progress(`text saved: ${document.pages ?? '?'} page(s), ${document.chars} characters`);
  }

  // Submit a set of documents to the analysis, with the module's status
  // walked through analyzing → complete/failed and the panel job chained
  // behind a successful run — the tail both analysis jobs share.
  async function runManualAnalysis(job, module, candidates, flags, progress) {
    const { Module } = db.models;
    // Documents in the set may be byte-for-byte identical (a companion equal
    // to the primary page). Submit each content only once.
    const seenAnalysisHashes = new Set();
    const analysisManuals = candidates.filter((m) => {
      if (seenAnalysisHashes.has(m.hash)) return false;
      seenAnalysisHashes.add(m.hash);
      return true;
    });
    await Module.update({ analysis_status: 'analyzing' }, { where: { id: module.id } });
    const documentLabel = analysisManuals.length === 1 ? 'document' : 'documents';
    progress(
      `analyzing ${analysisManuals.length} ${documentLabel}: ` +
        analysisManuals.map((m) => m.original_name || `${m.hash}.pdf`).join(', ')
    );
    let analyzed = 0;
    try {
      const { components } = await analyzeManualForModule(
        db,
        flags.backend,
        module,
        analysisManuals.map((m) => manualPath(manualsDir, m.hash)),
        {
          productPage: flags.productPage,
          buildDoc: flags.buildDoc && analysisManuals.length > 1,
          retailerPages: flags.retailerPages && analysisManuals.length > 1,
        }
      );
      analyzed = components.length;
      progress(`analysis complete: ${components.length} component(s) found`);
    } catch (e) {
      await Module.update({ analysis_status: 'failed' }, { where: { id: module.id } });
      throw e;
    }
    // The panel needs the component list the analysis just wrote, so it is
    // chained rather than run alongside. A module whose panel job fails still
    // has a complete analysis. An analysis that found no components at all
    // has nothing to place on a panel, so there is nothing to queue.
    if (analyzed > 0 && (await enqueueModuleJob(db, 'panel_image', module, job.user_id))) {
      progress('queued front panel image');
    }
  }

  // The module's shared documents and the one among them that is the manual
  // proper — retailer pages and build documents are only ever companions.
  async function sharedManualDocuments(module) {
    const manuals = await db.models.Manual.findAll({
      where: { module_id: module.id, user_id: null },
      order: [['id', 'ASC']],
    });
    return {
      manuals,
      manual: manuals.find((m) => !isCompanionDocumentName(m.original_name)) ?? null,
    };
  }

  // The documents that ride along with the manual: everything marked in
  // scope for analysis — the shared ones (vendor pages arrive marked; the
  // user marks or unmarks the rest on the module page) plus the job owner's
  // own marked uploads. Another user's upload never joins, marked or not:
  // scope is a request to read the document, not permission to.
  async function analysisScopeDocuments(module, userId) {
    const rows = await db.models.Manual.findAll({
      where: { module_id: module.id, analysis_scope: true },
      order: [['id', 'ASC']],
    });
    return rows.filter((m) => m.user_id === null || (userId && m.user_id === userId));
  }

  // Analyze the in-scope documents: the manual proper — which arrives marked
  // in scope and leads the set while it stays marked — plus every other
  // marked document. Unmarking the manual leaves it out like anything else;
  // the first remaining document then leads. The prompt flags describe what
  // the set is made of: a rendered product page standing in for the manual,
  // retailer listings, a build document.
  async function runScopedAnalysis(job, module, manual, backend, progress) {
    const scoped = (await analysisScopeDocuments(module, job.user_id)).filter(
      (m) => m.id !== manual.id
    );
    const candidates = manual.analysis_scope ? [manual, ...scoped] : scoped;
    if (candidates.length === 0) {
      throw new Error(
        'No documents are marked in scope for analysis — mark the manual ' +
          '(or another document) on the module page and try again'
      );
    }
    if (!manual.analysis_scope) {
      progress('the manual is unmarked for analysis and stays out of the set');
    }
    const [primary, ...companions] = candidates;
    const productPage = /_Product_Page\.pdf$/i.test(primary.original_name || '');
    const hasRetailerPage = companions.some(
      (m) => isRetailerPageName(m.original_name) || isPerfectCircuitDocument(m)
    );
    const hasBuildDoc = companions.some(isBuildDocument);
    await runManualAnalysis(
      job,
      module,
      candidates,
      {
        backend,
        productPage,
        buildDoc: productPage && hasBuildDoc && !hasRetailerPage,
        retailerPages: !productPage,
      },
      progress
    );
  }

  // Fill in the facts the analysis never wrote — descriptions of components
  // the user added by hand, a missing summary, a missing HP width. One
  // narrow model pass over the same document set the analysis reads; a fact
  // that already exists is never overwritten (services/componentDescriber.js).
  async function handleDescribeComponents(job, backend, progress) {
    const { Module } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });
    const gaps = await moduleFactGaps(db, module);
    if (gaps.components.length === 0 && !gaps.summary && !gaps.hp) {
      progress('nothing is missing — every fact is already filled in');
      return;
    }
    const missing = gaps.components;
    const { manual } = await sharedManualDocuments(module);
    const scoped = (await analysisScopeDocuments(module, job.user_id)).filter(
      (m) => m.id !== manual?.id
    );
    const seen = new Set();
    const candidates = (manual?.analysis_scope ? [manual, ...scoped] : scoped).filter((m) => {
      if (seen.has(m.hash)) return false;
      seen.add(m.hash);
      return true;
    });
    if (candidates.length === 0) {
      throw new Error('This module has no documents to read descriptions from');
    }
    const wanted = [
      missing.length > 0 ? `${missing.length} component description(s)` : null,
      gaps.summary ? 'the summary' : null,
      gaps.hp ? 'the HP width' : null,
    ].filter(Boolean);
    progress(
      `filling in ${wanted.join(', ')} from ` +
        candidates.map((m) => m.original_name || `${m.hash}.pdf`).join(', ')
    );
    const result = await describeComponentsForModule(
      db,
      backend,
      module,
      candidates.map((m) => manualPath(manualsDir, m.hash))
    );
    progress(
      `descriptions written: ${result.described} of ${missing.length}` +
        (result.summary ? '; summary filled in' : '') +
        (result.hp ? '; HP filled in' : '')
    );
  }

  async function handleAnalyzeManual(job, backend, progress) {
    const { Module } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });
    // Everything marked in scope for analysis is what gets analyzed. The
    // shared auto-found manual arrives marked and leads the set, but the
    // user can unmark it like any other document.
    const { manual } = await sharedManualDocuments(module);
    if (!manual) {
      throw new Error(`Module ${module.manufacturer} ${module.name} has no manual to analyze`);
    }
    await runScopedAnalysis(job, module, manual, backend, progress);
  }

  // Re-run the component analysis with fresh retailer product pages beside
  // the manual: fetch the module's page from each retailer that lists it,
  // save every render as a shared document, and submit the lot together.
  // The route refuses to queue this while any retailer page already exists,
  // so the fetch never piles renders up.
  async function handleReanalyzeComponents(job, backend, progress) {
    const { Module } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });
    const { manual } = await sharedManualDocuments(module);
    if (!manual) {
      throw new Error(`Module ${module.manufacturer} ${module.name} has no manual to analyze`);
    }
    progress(`searching retailer product pages: ${module.manufacturer} ${module.name}`.trim());
    const pages = await fetchRetailerPagesForModule(db, backend, module, manualsDir, {
      renderImpl,
      log: progress,
    });
    if (pages.length === 0) {
      progress('no retailer product pages found; re-analyzing from the manual alone');
    } else {
      progress(`product pages saved: ${pages.map((p) => p.original_name).join(', ')}`);
    }
    // The new pages become searchable like every other saved document. The
    // extraction needs nothing from the analysis, so it runs alongside.
    for (const page of pages) {
      if (await enqueueExtractManual(db, page, job.user_id)) {
        progress(`queued text extraction: ${page.original_name}`);
      }
    }
    // The fetched pages were saved marked in scope, so the scoped analysis
    // picks them up along with everything else the user marked.
    await runScopedAnalysis(job, module, manual, backend, progress);
  }

  async function handlePanelImage(job, backend, progress) {
    const { Module, Manual } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });
    // The shared auto-found manual is what the drawn-panel fallback reads.
    const manual = await Manual.findOne({
      where: { module_id: module.id, user_id: null },
      order: [['id', 'ASC']],
    });
    await Module.update({ panel_status: 'searching' }, { where: { id: module.id } });
    progress(`building front panel: ${module.manufacturer} ${module.name}`.trim());
    try {
      const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
        fetchImpl,
        log: progress,
        manualFile: manual ? manualPath(manualsDir, manual.hash) : null,
      });
      progress(
        `panel ready (${panel.source}): ${placements.filter((p) => p.component_id).length} ` +
          'component(s) placed'
      );
    } catch (e) {
      await Module.update({ panel_status: 'failed' }, { where: { id: module.id } });
      throw e;
    }
  }

  // The video row a video job is about. Both video handlers walk the row's
  // own status, like the question handlers walk the question's.
  async function jobVideo(job) {
    const payload = JSON.parse(job.payload || '{}');
    const record = await db.models.ModuleVideo.findByPk(payload.video_id);
    if (!record) throw new Error(`Video ${payload.video_id} no longer exists`);
    return record.get({ plain: true });
  }

  async function handleDownloadVideo(job, backend, progress) {
    const { ModuleVideo } = db.models;
    const video = await jobVideo(job);
    await ModuleVideo.update({ status: 'downloading', error: null }, { where: { id: video.id } });
    try {
      progress(`downloading video: ${video.url}`);
      const result = await downloadVideoImpl(video, videosDir, { log: progress });
      await ModuleVideo.update(
        {
          title: result.title,
          channel: result.channel,
          duration_seconds: result.duration_seconds,
          status: 'downloaded',
        },
        { where: { id: video.id } }
      );
    } catch (e) {
      await ModuleVideo.update(
        { status: 'failed', error: e.message },
        { where: { id: video.id } }
      );
      throw e;
    }
    // The analysis needs the frames and transcript this job just wrote, so it
    // is chained rather than run alongside.
    if (await enqueueVideoJob(db, 'analyze_video', video, job.user_id)) {
      progress('queued video analysis');
    }
  }

  async function handleAnalyzeVideo(job, backend, progress) {
    const { Module, ModuleVideo } = db.models;
    const video = await jobVideo(job);
    const record = await Module.findByPk(video.module_id);
    if (!record) throw new Error(`Module ${video.module_id} no longer exists`);
    const module = record.get({ plain: true });
    await ModuleVideo.update({ status: 'analyzing', error: null }, { where: { id: video.id } });
    progress(`analyzing video: '${video.title || video.url}'`);
    try {
      await analyzeVideoImpl(db, backend, module, video, videosDir, { log: progress });
    } catch (e) {
      await ModuleVideo.update(
        { status: 'failed', error: e.message },
        { where: { id: video.id } }
      );
      throw e;
    }
    // What the user keeps is the row: the link and the summary. The frames
    // and transcript have served their purpose (kept until now so a failed
    // attempt could retry without re-downloading).
    removeVideoFiles(videosDir, video);
    progress('summary saved; the downloaded video files are deleted');
  }

  async function handleScopeQuestion(job, backend, progress) {
    const { Question } = db.models;
    const record = await Question.findByPk(job.question_id);
    if (!record) throw new Error(`Question ${job.question_id} no longer exists`);
    const question = record.get({ plain: true });
    await Question.update({ status: 'scoping' }, { where: { id: question.id } });
    try {
      // scopeQuestion marks the question 'scoped' once the links are saved.
      await scopeQuestion(db, backend, question, { log: progress });
      progress('scope saved, ready for review');
    } catch (e) {
      await Question.update({ status: 'failed', error: e.message }, { where: { id: question.id } });
      throw e;
    }
  }

  async function handleAnswerQuestion(job, backend, progress) {
    const { Question } = db.models;
    const record = await Question.findByPk(job.question_id);
    if (!record) throw new Error(`Question ${job.question_id} no longer exists`);
    const question = record.get({ plain: true });
    await Question.update({ status: 'answering' }, { where: { id: question.id } });
    try {
      await answerQuestion(db, backend, question, manualsDir, {
        log: progress,
        capturesDir,
      });
      progress('answer saved');
    } catch (e) {
      await Question.update({ status: 'failed', error: e.message }, { where: { id: question.id } });
      throw e;
    }
  }

  async function handleExportRack(job, backend, progress) {
    const payload = JSON.parse(job.payload || '{}');
    const rack = await db.models.Rack.findOne({
      where: { id: payload.rack_id, user_id: job.user_id },
    });
    if (!rack) throw new Error(`Rack ${payload.rack_id} no longer exists`);
    progress(`collecting documents for rack '${rack.name}'`);
    const { entryCount } = await writeRackExport(db, job.user_id, rack, job.id, {
      manualsDir,
      exportsDir,
      log: progress,
    });
    // The 'completed' event carries the link (via jobSummary); the client
    // auto-downloads it, and the exports route deletes the file once served.
    await db.models.Job.update(
      {
        payload: JSON.stringify({
          ...payload,
          filename: `${safeSegment(rack.name)}.zip`,
          download: `/api/exports/${job.id}`,
        }),
      },
      { where: { id: job.id } }
    );
    progress(`zipped ${entryCount} document(s)`);
  }

  return {
    import: handleImport,
    find_manual: handleFindManual,
    analyze_manual: handleAnalyzeManual,
    reanalyze_components: handleReanalyzeComponents,
    describe_components: handleDescribeComponents,
    extract_manual: handleExtractManual,
    panel_image: handlePanelImage,
    download_video: handleDownloadVideo,
    analyze_video: handleAnalyzeVideo,
    scope_question: handleScopeQuestion,
    answer_question: handleAnswerQuestion,
    export_rack: handleExportRack,
  };
}
