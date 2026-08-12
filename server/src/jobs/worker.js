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
  const { rows } = await db.query(
    `INSERT INTO jobs (type, user_id, module_id, question_id, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
    [type, userId, moduleId, questionId, payload ? JSON.stringify(payload) : null]
  );
  return rows[0];
}

// Queue a find_manual job unless the module already has a manual or a live
// job. The job is owned by (and visible to) the user whose import queued it.
export async function enqueueFindManual(db, module, userId) {
  if (module.manual_status === 'found') return null;
  const { rows: pending } = await db.query(
    `SELECT id FROM jobs
     WHERE module_id = $1 AND type = 'find_manual' AND status IN ('pending', 'running')`,
    [module.id]
  );
  if (pending.length > 0) return null;
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
      const { rows } = await db.query('SELECT user_id FROM questions WHERE id = $1', [
        job.question_id,
      ]);
      return rows.map((r) => r.user_id);
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
    const { rows } = await db.query(
      `SELECT * FROM jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1`
    );
    if (rows.length === 0) return null;
    const { rows: claimed } = await db.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [rows[0].id]
    );
    return claimed[0] || null;
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
    const { rows } = await db.query('SELECT * FROM modules WHERE id = $1', [job.module_id]);
    if (rows.length === 0) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = rows[0];

    await db.query(
      `UPDATE modules SET manual_status = 'searching', updated_at = now() WHERE id = $1`,
      [module.id]
    );
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
    const { rows: pending } = await db.query(
      `SELECT id FROM jobs
       WHERE module_id = $1 AND type = 'analyze_manual' AND status IN ('pending', 'running')`,
      [module.id]
    );
    if (pending.length === 0) {
      // The analysis job inherits the owner of the find job that chained it.
      await enqueueJob(db, 'analyze_manual', { moduleId: module.id, userId: job.user_id });
      progress('queued manual analysis');
    }
  }

  async function handleAnalyzeManual(job, backend, progress) {
    const { rows } = await db.query('SELECT * FROM modules WHERE id = $1', [job.module_id]);
    if (rows.length === 0) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = rows[0];
    // The shared auto-found manual is what gets analyzed.
    const { rows: manuals } = await db.query(
      `SELECT filename FROM manuals WHERE module_id = $1 AND user_id IS NULL ORDER BY id LIMIT 1`,
      [module.id]
    );
    if (manuals.length === 0) {
      throw new Error(`Module ${module.manufacturer} ${module.name} has no manual to analyze`);
    }
    await db.query(
      `UPDATE modules SET analysis_status = 'analyzing', updated_at = now() WHERE id = $1`,
      [module.id]
    );
    progress(`analyzing manual: ${manuals[0].filename}`);
    try {
      const { components } = await analyzeManualForModule(
        db,
        backend,
        module,
        path.join(manualsDir, manuals[0].filename)
      );
      progress(`analysis complete: ${components.length} component(s) found`);
    } catch (e) {
      await db.query(
        `UPDATE modules SET analysis_status = 'failed', updated_at = now() WHERE id = $1`,
        [module.id]
      );
      throw e;
    }
  }

  async function handleAnswerQuestion(job, backend, progress) {
    const { rows } = await db.query('SELECT * FROM questions WHERE id = $1', [job.question_id]);
    if (rows.length === 0) throw new Error(`Question ${job.question_id} no longer exists`);
    const question = rows[0];
    await db.query(`UPDATE questions SET status = 'answering' WHERE id = $1`, [question.id]);
    try {
      await answerQuestion(db, backend, question, manualsDir, { log: progress });
      progress('answer saved');
    } catch (e) {
      await db.query(
        `UPDATE questions SET status = 'failed', error = $2 WHERE id = $1`,
        [question.id, e.message]
      );
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
      const { rows } = await db.query(
        `UPDATE jobs SET status = 'complete', error = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [job.id]
      );
      publish(owners, 'completed', rows[0]);
      return rows[0];
    } catch (e) {
      const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const { rows } = await db.query(
        `UPDATE jobs SET status = $2, error = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [job.id, status, e.message]
      );
      publish(owners, status === 'failed' ? 'failed' : 'progress', rows[0],
        status === 'failed' ? e.message : `attempt failed, will retry: ${e.message}`);
      return rows[0];
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
