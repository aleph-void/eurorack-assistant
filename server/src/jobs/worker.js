// DB-backed job worker. Polls the jobs table and processes pending jobs with
// up to `import_workers` (app_config) concurrent runners. Job types:
//   import          — parse an import (text/csv/modulargrid), create module
//                     records, and queue a find_manual job per new module
//   find_manual     — research + download the module's manual PDF, then queue
//                     an analyze_manual job for it
//   analyze_manual  — LLM analysis of the manual into a summary + components,
//                     then queue a panel_image job for it
//   panel_image     — find (or draw) the module's front panel and place every
//                     analyzed component on it
//   scope_question  — determine which modules/jacks a question applies to,
//                     then leave the question 'scoped' for the user to review
//   answer_question — ask the LLM with the reviewed scope and attachments
//   export_rack     — zip a rack's manuals, notes and questions into a
//                     one-shot download served by the exports route
//
// Progress is published per-user on the event bus, which the WebSocket server
// forwards to the browser.

import os from 'node:os';
import { createBackend } from '../services/llm.js';
import { manualPath, renderPageToPdf } from '../services/pdf.js';
import { getLlmSettings, getImportWorkerCount, DEFAULT_IMPORT_WORKERS } from '../services/config.js';
import {
  parseModuleCsv,
  parseModuleLines,
  fetchModulargridRack,
  importModules,
} from '../services/importer.js';
import { findManualForModule } from '../services/manualFinder.js';
import { analyzeManualForModule } from '../services/manualAnalyzer.js';
import { buildPanelForModule } from '../services/panelImage.js';
import { answerQuestion, scopeQuestion } from '../services/ask.js';
import { safeSegment, writeRackExport } from '../services/rackExport.js';

export const MAX_ATTEMPTS = 3;

// A claimed job carries a lease: the runner refreshes heartbeat_at every
// HEARTBEAT_MS, and any 'running' row that has gone quiet for STALE_JOB_MS is
// presumed orphaned — its process was killed mid-job — and goes back on the
// queue. Without this a redeploy stranded in-flight jobs in 'running' forever
// (their modules stuck 'analyzing', and the dedupe guards below refusing to
// queue the work again because a job for it was apparently still live).
export const HEARTBEAT_MS = 30 * 1000;
export const STALE_JOB_MS = 5 * 60 * 1000;

// Ceiling on a single attempt. The LLM CLI has its own (shorter) timeout, so
// this only catches a job wedged somewhere else — but a runner stuck forever
// costs the pool a slot, and six of them cost the whole pool.
export const JOB_TIMEOUT_MS = 45 * 60 * 1000;

// Timestamp of the last sign of life from whoever holds a running job. Rows
// claimed before leases existed have no heartbeat, so fall back to updated_at.
export function lastSeenAt(job) {
  const seen = job.heartbeat_at || job.updated_at;
  return seen ? new Date(seen) : null;
}

// Resolves with `promise`, or rejects once `ms` have passed.
export function withTimeout(promise, ms, message) {
  let timer = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export function isStalled(job, staleMs = STALE_JOB_MS, now = Date.now()) {
  if (job.status !== 'running') return false;
  const seen = lastSeenAt(job);
  return !seen || now - seen.getTime() >= staleMs;
}

export async function enqueueJob(db, type, { userId = null, moduleId = null, questionId = null, payload = null } = {}) {
  const job = await db.models.Job.create({
    type,
    user_id: userId,
    module_id: moduleId,
    question_id: questionId,
    payload: payload ? JSON.stringify(payload) : null,
    status: 'pending',
  });
  return job.get({ plain: true });
}

// Queue a per-module job unless one of the same type is already live for that
// module — the chained pipeline (find_manual → analyze_manual → panel_image)
// and the "re-analyze everything" action both have to be safe to trigger
// twice. The job is owned by (and visible to) the user who caused it.
export async function enqueueModuleJob(db, type, module, userId) {
  const pending = await db.models.Job.findOne({
    where: { module_id: module.id, type, status: ['pending', 'running'] },
  });
  if (pending) return null;
  return enqueueJob(db, type, { moduleId: module.id, userId });
}

// Imports always re-try retrieval from the internet — an unchanged manual
// dedupes by content hash against the existing document record.
export const enqueueFindManual = (db, module, userId) =>
  enqueueModuleJob(db, 'find_manual', module, userId);

export function createWorker(db, options = {}) {
  const {
    manualsDir = process.env.MANUALS_DIR || '/data/manuals',
    exportsDir = process.env.EXPORTS_DIR || '/data/exports',
    capturesDir = process.env.CAPTURES_DIR || '/data/captures',
    panelsDir = process.env.PANELS_DIR || '/data/panels',
    pollIntervalMs = 5000,
    heartbeatMs = HEARTBEAT_MS,
    staleJobMs = STALE_JOB_MS,
    jobTimeoutMs = JOB_TIMEOUT_MS,
    workerId = `${os.hostname()}#${process.pid}`,
    backendFactory = createBackend,
    fetchImpl = fetch,
    renderImpl = renderPageToPdf,
    bus = null,
    log = (...args) => console.log('[worker]', ...args),
  } = options;

  // Jobs this process holds a lease on, by id. Their heartbeats are refreshed
  // while they run, they are never reclaimed from under us, and they are
  // handed back to the queue if the process is asked to shut down.
  const held = new Map();

  // The user a job belongs to. Every job is stamped with the user who caused
  // it at enqueue time; job status and progress events are visible to that
  // user only (module/question state itself is updated for everyone).
  async function jobOwners(job) {
    if (job.user_id) return [job.user_id];
    if (job.question_id) {
      const question = await db.models.Question.findByPk(job.question_id);
      return question ? [question.user_id] : [];
    }
    return [];
  }

  // What the job is about, in the same shape the jobs API returns — the
  // client renders WebSocket job events directly, so without these fields a
  // job that first appears over the socket would have no target label.
  async function jobLabels(job) {
    const labels = { module_manufacturer: null, module_name: null, question_prompt: null };
    if (job.module_id) {
      const module = await db.models.Module.findByPk(job.module_id);
      if (module) {
        labels.module_manufacturer = module.manufacturer;
        labels.module_name = module.name;
      }
    }
    if (job.question_id) {
      const question = await db.models.Question.findByPk(job.question_id);
      if (question) labels.question_prompt = question.prompt;
    }
    return labels;
  }

  function jobSummary(job) {
    const {
      id,
      type,
      module_id,
      question_id,
      status,
      attempts,
      error,
      module_manufacturer = null,
      module_name = null,
      question_prompt = null,
    } = job;
    // export_rack jobs carry their target rack and, once complete, the
    // download link in the payload.
    let rack_name = null;
    let download = null;
    if (job.payload) {
      try {
        const payload = JSON.parse(job.payload);
        rack_name = payload.rack_name ?? null;
        download = payload.download ?? null;
      } catch {
        // payload is not JSON (never the case for export jobs)
      }
    }
    return {
      id,
      type,
      module_id,
      question_id,
      status,
      attempts,
      error,
      module_manufacturer,
      module_name,
      question_prompt,
      rack_name,
      download,
    };
  }

  function publish(userIds, event, job, message) {
    log(`job ${job.id} (${job.type}) ${event}${message ? `: ${message}` : ''}`);
    if (!bus) return;
    for (const userId of userIds) {
      bus.publish(userId, { kind: 'job', event, job: jobSummary(job), message });
    }
  }

  async function claimNextJob() {
    const { Job } = db.models;
    // Concurrent workers can race for the same pending row; the guarded
    // update decides the winner and the loser moves on to the next row.
    for (;;) {
      const next = await Job.findOne({ where: { status: 'pending' }, order: [['id', 'ASC']] });
      if (!next) return null;
      const now = new Date();
      const [, claimed] = await Job.update(
        {
          status: 'running',
          attempts: next.attempts + 1,
          started_at: now,
          heartbeat_at: now,
          worker_id: workerId,
        },
        { where: { id: next.id, status: 'pending' }, returning: true }
      );
      if (claimed[0]) return claimed[0].get({ plain: true });
    }
  }

  // Tell the database the jobs this process holds are still being worked on.
  // `silent` keeps updated_at meaning "last state change" rather than "last
  // heartbeat", which is what the jobs list shows.
  async function heartbeat() {
    if (held.size === 0) return;
    await db.models.Job.update(
      { heartbeat_at: new Date() },
      { where: { id: [...held.keys()], status: 'running' }, silent: true }
    );
  }

  // A job's target carries its own status for the UI; when the job goes back
  // to the queue (or gives up) that has to be walked back too, otherwise a
  // module sits on 'analyzing' with nothing analyzing it.
  async function resetJobTarget(job, status, message) {
    const { Module, Question } = db.models;
    const failed = status === 'failed';
    if (job.type === 'find_manual' && job.module_id) {
      await Module.update(
        { manual_status: failed ? 'failed' : 'pending' },
        { where: { id: job.module_id } }
      );
    } else if (job.type === 'analyze_manual' && job.module_id) {
      await Module.update(
        { analysis_status: failed ? 'failed' : 'pending' },
        { where: { id: job.module_id } }
      );
    } else if (job.type === 'panel_image' && job.module_id) {
      await Module.update(
        { panel_status: failed ? 'failed' : 'pending' },
        { where: { id: job.module_id } }
      );
    } else if (failed && job.question_id) {
      await Question.update(
        { status: 'failed', error: message },
        { where: { id: job.question_id } }
      );
    }
  }

  // Put a running job back: on the queue if it has attempts left, otherwise
  // failed. Guarded on the row still being 'running' so a job another process
  // finished in the meantime is left alone.
  async function requeue(job, message, { refundAttempt = false } = {}) {
    const { Job } = db.models;
    const attempts = refundAttempt ? Math.max(0, job.attempts - 1) : job.attempts;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const [, rows] = await Job.update(
      { status, attempts, error: message, worker_id: null, heartbeat_at: null, started_at: null },
      { where: { id: job.id, status: 'running' }, returning: true }
    );
    if (!rows || !rows[0]) return null;
    await resetJobTarget(job, status, message);
    const row = { ...rows[0].get({ plain: true }), ...(await jobLabels(job)) };
    publish(await jobOwners(job), status === 'failed' ? 'failed' : 'progress', row, message);
    return row;
  }

  // Requeue jobs whose holder has gone quiet. Runs on every wake-up: a job
  // orphaned by a killed process is otherwise stuck in 'running' for good.
  async function reclaimStaleJobs() {
    const running = await db.models.Job.findAll({ where: { status: 'running' } });
    const now = Date.now();
    const reclaimed = [];
    for (const record of running) {
      const job = record.get({ plain: true });
      if (held.has(job.id)) continue; // ours, and being worked on right now
      if (!isStalled(job, staleJobMs, now)) continue;
      const seen = lastSeenAt(job);
      const row = await requeue(
        job,
        `worker stopped before the job finished (no progress since ${
          seen ? seen.toISOString() : 'it was claimed'
        })`
      );
      if (row) reclaimed.push(row);
    }
    if (reclaimed.length > 0) {
      log(`reclaimed ${reclaimed.length} stalled job(s): ${reclaimed.map((j) => j.id).join(', ')}`);
    }
    return reclaimed;
  }

  // Hand every held job straight back on shutdown rather than waiting for its
  // lease to go stale. A deploy is not the job's fault, so the attempt it was
  // partway through is refunded.
  async function releaseHeldJobs() {
    const jobs = [...held.values()];
    held.clear();
    for (const job of jobs) {
      await requeue(job, 'worker shut down before the job finished; requeued', {
        refundAttempt: true,
      });
    }
    if (jobs.length > 0) log(`released ${jobs.length} in-flight job(s) back to the queue`);
  }

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

    // Chain the analysis job once the manual is on disk.
    const pending = await db.models.Job.findOne({
      where: { module_id: module.id, type: 'analyze_manual', status: ['pending', 'running'] },
    });
    if (!pending) {
      // The analysis job inherits the owner of the find job that chained it.
      await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: job.user_id });
      progress('queued manual analysis');
    }
  }

  async function handleAnalyzeManual(job, backend, progress) {
    const { Module, Manual } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });
    // The shared auto-found manual is what gets analyzed.
    const manual = await Manual.findOne({
      where: { module_id: module.id, user_id: null },
      order: [['id', 'ASC']],
    });
    if (!manual) {
      throw new Error(`Module ${module.manufacturer} ${module.name} has no manual to analyze`);
    }
    await Module.update({ analysis_status: 'analyzing' }, { where: { id: module.id } });
    progress(`analyzing manual: ${manual.original_name || `${manual.hash}.pdf`}`);
    let analyzed = 0;
    try {
      const { components } = await analyzeManualForModule(
        db,
        backend,
        module,
        manualPath(manualsDir, manual.hash)
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

  const handlers = {
    import: handleImport,
    find_manual: handleFindManual,
    analyze_manual: handleAnalyzeManual,
    panel_image: handlePanelImage,
    scope_question: handleScopeQuestion,
    answer_question: handleAnswerQuestion,
    export_rack: handleExportRack,
  };

  // Process a single pending job if there is one. Returns the finished job row
  // or null. Exposed for tests and for the poll loop.
  async function tick() {
    const job = await claimNextJob();
    if (!job) return null;
    return runJob(job);
  }

  async function runJob(job) {
    const owners = await jobOwners(job);
    const labels = await jobLabels(job);
    Object.assign(job, labels);
    const progress = (message) => publish(owners, 'progress', job, message);

    held.set(job.id, job);
    publish(owners, 'started', job, `attempt ${job.attempts}`);
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`Unknown job type: ${job.type}`);
      const backend = backendFactory(await getLlmSettings(db, job.type));
      // The handler is raced rather than aborted: it has no cancellation to
      // offer, so the attempt is given up on and the runner freed. Whatever it
      // was waiting for is left to finish and be ignored.
      await withTimeout(
        handler(job, backend, progress),
        jobTimeoutMs,
        `job exceeded its ${Math.round(jobTimeoutMs / 60000)} minute time limit`
      );
      const [, doneRows] = await db.models.Job.update(
        { status: 'complete', error: null },
        { where: { id: job.id }, returning: true }
      );
      const done = { ...doneRows[0].get({ plain: true }), ...labels };
      publish(owners, 'completed', done);
      return done;
    } catch (e) {
      const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const [, failedRows] = await db.models.Job.update(
        { status, error: e.message },
        { where: { id: job.id }, returning: true }
      );
      const failed = { ...failedRows[0].get({ plain: true }), ...labels };
      publish(owners, status === 'failed' ? 'failed' : 'progress', failed,
        status === 'failed' ? e.message : `attempt failed, will retry: ${e.message}`);
      return failed;
    } finally {
      held.delete(job.id);
    }
  }

  let timer = null;
  let heartbeatTimer = null;
  let running = false;
  let stopped = false;

  async function loop() {
    if (running) return;
    running = true;
    try {
      // Jobs left 'running' by a process that died mid-job go back on the
      // queue before this pass claims anything, so a restart picks up the
      // work it was interrupted doing.
      try {
        await reclaimStaleJobs();
      } catch (e) {
        log(`could not reclaim stalled jobs: ${e.message}`);
      }
      // The worker count is admin-configurable (app_config.import_workers)
      // and re-read on every wake-up, so changes apply without a restart.
      let workers = DEFAULT_IMPORT_WORKERS;
      try {
        workers = await getImportWorkerCount(db);
      } catch (e) {
        log(`could not read import_workers, using default ${workers}: ${e.message}`);
      }
      // Drain the queue with `workers` concurrent runners, then go back to
      // sleep. A runner that finds the queue empty must not exit while a
      // sibling is still mid-job: jobs chain (import → find_manual →
      // analyze_manual), so the busy sibling may be about to enqueue work
      // that should run at full concurrency too.
      let working = 0;
      const idleDelayMs = Math.min(pollIntervalMs, 200);
      const runner = async () => {
        while (!stopped) {
          const job = await claimNextJob();
          if (job) {
            working += 1;
            try {
              await runJob(job);
            } finally {
              working -= 1;
            }
            continue;
          }
          if (working === 0) return;
          await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
        }
      };
      await Promise.all(Array.from({ length: workers }, runner));
    } catch (e) {
      log(`worker loop error: ${e.message}`);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    reclaimStaleJobs,
    workerId,
    start() {
      stopped = false;
      timer = setInterval(loop, pollIntervalMs);
      heartbeatTimer = setInterval(() => {
        heartbeat().catch((e) => log(`heartbeat failed: ${e.message}`));
      }, heartbeatMs);
      loop();
    },
    // Awaited on shutdown: the in-flight jobs are given back to the queue so
    // the next process runs them immediately instead of waiting out a lease.
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      timer = null;
      heartbeatTimer = null;
      await releaseHeldJobs();
    },
  };
}
