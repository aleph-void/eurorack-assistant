// DB-backed job worker. Polls the jobs table and processes one job at a time:
//   import          — parse an import (text/csv/modulargrid), create module
//                     records, and queue a find_manual job per new module
//   find_manual     — research + download the module's manual PDF, then queue
//                     an analyze_manual job for it
//   analyze_manual  — LLM analysis of the manual into a summary + components
//   answer_question — scope the question, attach manuals, ask the LLM
//
// Progress is published per-user on the event bus, which the WebSocket server
// forwards to the browser.

import path from 'node:path';
import { createBackend } from '../services/llm.js';
import { getLlmSettings } from '../services/config.js';
import {
  parseModuleCsv,
  parseModuleLines,
  fetchModulargridRack,
  importModules,
} from '../services/importer.js';
import { findManualForModule } from '../services/manualFinder.js';
import { analyzeManualForModule } from '../services/manualAnalyzer.js';
import { answerQuestion } from '../services/ask.js';

export const MAX_ATTEMPTS = 3;

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

// Queue a find_manual job unless the module already has a manual or a live
// job. The job is owned by (and visible to) the user whose import queued it.
export async function enqueueFindManual(db, module, userId) {
  if (module.manual_status === 'found') return null;
  const pending = await db.models.Job.findOne({
    where: { module_id: module.id, type: 'find_manual', status: ['pending', 'running'] },
  });
  if (pending) return null;
  return enqueueJob(db, 'find_manual', { moduleId: module.id, userId });
}

export function createWorker(db, options = {}) {
  const {
    manualsDir = process.env.MANUALS_DIR || '/data/manuals',
    pollIntervalMs = 5000,
    backendFactory = createBackend,
    fetchImpl = fetch,
    bus = null,
    log = (...args) => console.log('[worker]', ...args),
  } = options;

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

  function jobSummary(job) {
    const { id, type, module_id, question_id, status, attempts, error } = job;
    return { id, type, module_id, question_id, status, attempts, error };
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
    const next = await Job.findOne({ where: { status: 'pending' }, order: [['id', 'ASC']] });
    if (!next) return null;
    const [, claimed] = await Job.update(
      { status: 'running', attempts: next.attempts + 1 },
      { where: { id: next.id, status: 'pending' }, returning: true }
    );
    return claimed[0] ? claimed[0].get({ plain: true }) : null;
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
    const results = await importModules(db, job.user_id, items);
    let queued = 0;
    for (const { module, created, added } of results) {
      const verb = created ? 'created' : added ? 'added to your system' : 'updated';
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
    const manualName = await findManualForModule(db, backend, module, manualsDir, {
      fetchImpl,
      log: progress,
    });
    if (!manualName) {
      throw new Error(`No manual PDF found for ${module.manufacturer} ${module.name}`);
    }
    progress(`manual saved: ${manualName}`);

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
    progress(`analyzing manual: ${manual.filename}`);
    try {
      const { components } = await analyzeManualForModule(
        db,
        backend,
        module,
        path.join(manualsDir, manual.filename)
      );
      progress(`analysis complete: ${components.length} component(s) found`);
    } catch (e) {
      await Module.update({ analysis_status: 'failed' }, { where: { id: module.id } });
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
      await answerQuestion(db, backend, question, manualsDir, { log: progress });
      progress('answer saved');
    } catch (e) {
      await Question.update({ status: 'failed', error: e.message }, { where: { id: question.id } });
      throw e;
    }
  }

  const handlers = {
    import: handleImport,
    find_manual: handleFindManual,
    analyze_manual: handleAnalyzeManual,
    answer_question: handleAnswerQuestion,
  };

  // Process a single pending job if there is one. Returns the finished job row
  // or null. Exposed for tests and for the poll loop.
  async function tick() {
    const job = await claimNextJob();
    if (!job) return null;
    const owners = await jobOwners(job);
    const progress = (message) => publish(owners, 'progress', job, message);

    publish(owners, 'started', job, `attempt ${job.attempts}`);
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`Unknown job type: ${job.type}`);
      const backend = backendFactory(await getLlmSettings(db));
      await handler(job, backend, progress);
      const [, doneRows] = await db.models.Job.update(
        { status: 'complete', error: null },
        { where: { id: job.id }, returning: true }
      );
      const done = doneRows[0].get({ plain: true });
      publish(owners, 'completed', done);
      return done;
    } catch (e) {
      const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const [, failedRows] = await db.models.Job.update(
        { status, error: e.message },
        { where: { id: job.id }, returning: true }
      );
      const failed = failedRows[0].get({ plain: true });
      publish(owners, status === 'failed' ? 'failed' : 'progress', failed,
        status === 'failed' ? e.message : `attempt failed, will retry: ${e.message}`);
      return failed;
    }
  }

  let timer = null;
  let running = false;
  let stopped = false;

  async function loop() {
    if (running) return;
    running = true;
    try {
      // Drain the queue, then go back to sleep.
      while (!stopped && (await tick()) !== null) {
        /* keep going */
      }
    } catch (e) {
      log(`worker loop error: ${e.message}`);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      stopped = false;
      timer = setInterval(loop, pollIntervalMs);
      loop();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
