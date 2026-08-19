// DB-backed job worker: the queue engine. Polls the jobs table and processes
// pending jobs with up to `import_workers` (app_config) concurrent runners.
// What each job type actually does lives in handlers.js; how work is queued
// in enqueue.js — both re-exported here so callers have one import point.
//
// Progress is published per-user on the event bus, which the WebSocket server
// forwards to the browser.

import os from 'node:os';
import { createBackend, detectQuotaExhaustion, takeQuotaExhaustion } from '../services/llm.js';
import { exhaustedUserIds, recordUsage } from '../services/budgets.js';
import {
  accountRuntime,
  getAccount,
  pauseAccount,
  sweepAccountPauses,
} from '../services/llmAccounts.js';
import {
  getLlmSettings,
  getImportWorkerCount,
  getQueuePause,
  pauseQueue,
  resumeQueue,
  DEFAULT_IMPORT_WORKERS,
} from '../services/config.js';
import { createHandlers } from './handlers.js';

export * from './enqueue.js';
export { isPerfectCircuitDocument, isBuildDocument } from './handlers.js';

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
//
// The ceiling scales with the attempt count: a job that timed out because the
// work is genuinely long (a 300-page manual, a slow model) fails identically
// on every retry against a fixed limit, so each attempt gets that much longer
// again — 45, then 90, then 135 minutes.
export const JOB_TIMEOUT_MS = 45 * 60 * 1000;

export const attemptTimeoutMs = (baseMs, attempts) => baseMs * Math.max(1, attempts || 1);

// How long the queue sleeps after the provider says the subscription is out
// of tokens but does not say when that changes. Claude's message carries the
// reset time and is used instead when it is there; this is the guess for when
// it is not — long enough not to spend the queue re-discovering the limit,
// short enough that the queue comes back on its own.
export const QUOTA_PAUSE_MS = 60 * 60 * 1000;

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

// A job's target carries its own status for the UI; when the job goes back to
// the queue (or gives up, or is stopped by hand) that has to be walked back
// too, otherwise a module sits on 'analyzing' with nothing analyzing it.
// Shared with the jobs route, which stops and deletes jobs out from under the
// worker.
export async function resetJobTarget(db, job, status, message) {
  const { Module, Question } = db.models;
  const settled = status === 'failed' || status === 'cancelled';
  if (job.type === 'find_manual' && job.module_id) {
    await Module.update(
      { manual_status: status === 'failed' ? 'failed' : 'pending' },
      { where: { id: job.module_id } }
    );
  } else if ((job.type === 'analyze_manual' || job.type === 'reanalyze_components') && job.module_id) {
    await Module.update(
      { analysis_status: status === 'failed' ? 'failed' : 'pending' },
      { where: { id: job.module_id } }
    );
  } else if (job.type === 'panel_image' && job.module_id) {
    await Module.update(
      { panel_status: status === 'failed' ? 'failed' : 'pending' },
      { where: { id: job.module_id } }
    );
    // A question whose job is never going to finish would otherwise spin on
    // 'scoping'/'answering' for good; 'failed' carries the reason and lets the
    // user ask again.
  } else if (settled && job.question_id) {
    await Question.update({ status: 'failed', error: message }, { where: { id: job.question_id } });
  }
}

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
    quotaPauseMs = QUOTA_PAUSE_MS,
    // How long the set of out-of-tokens users is reused for (see
    // heldForBudget). Tests that change a budget and expect the very next
    // claim to see it set this to 0.
    budgetCacheMs = 2000,
    workerId = `${os.hostname()}#${process.pid}`,
    // Where per-user CLI homes (and materialized codex auth files) live.
    llmDataDir = process.env.LLM_DIR || '/data/llm',
    backendFactory = createBackend,
    fetchImpl = fetch,
    renderImpl,
    extractImpl,
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

  // The queue is a shared resource — one exhausted subscription stops it for
  // everyone — so its state goes to every connected user rather than to the
  // owner of whichever job happened to hit the wall.
  function publishQueue(event, pause) {
    if (!bus?.publishAll) return;
    bus.publishAll({
      kind: 'queue',
      event,
      paused: Boolean(pause.paused),
      until: pause.until ?? null,
      reason: pause.reason ?? '',
    });
  }

  // Set while this process knows the queue is paused, so the runners mid-drain
  // stop claiming without going back to the database for every job.
  let quotaPaused = false;

  // Is the queue asleep? A pause whose time has come is cleared here, on
  // whichever worker notices first, and the queue announces itself back.
  async function queuePaused() {
    let pause;
    try {
      pause = await getQueuePause(db);
    } catch (e) {
      // The pause is a safeguard; failing to read it must not stop the queue.
      log(`could not read the queue pause state: ${e.message}`);
      return false;
    }
    if (pause.paused) {
      quotaPaused = true;
      return true;
    }
    if (pause.expired) {
      await resumeQueue(db);
      log('queue pause expired; resuming');
      publishQueue('resumed', { paused: false, until: null, reason: '' });
    }
    quotaPaused = false;
    return false;
  }

  // An LLM CLI reported the subscription is out of tokens, either by failing
  // this job or somewhere a caller swallowed (see takeQuotaExhaustion). Stop
  // the whole queue until the limit lifts: every job left in it runs the same
  // provider and would fail the same way, three attempts at a time.
  async function pauseForQuota(quota) {
    const resetAt =
      quota.resetAt && quota.resetAt > Date.now() ? quota.resetAt : Date.now() + quotaPauseMs;
    const until = new Date(resetAt);
    const reason = quota.message || 'the LLM provider reported the subscription is out of tokens';
    quotaPaused = true;
    await pauseQueue(db, { until, reason });
    log(`queue paused until ${until.toISOString()}: ${reason}`);
    publishQueue('paused', { paused: true, until: until.toISOString(), reason });
    return until;
  }

  // The quota exhaustion behind a finished job, if there was one: what the
  // job threw, what this job's own CLI runs reported (`noted`, collected via
  // the backend's onQuota hook — the attribution to trust with concurrent
  // runners on different accounts), or what any CLI run recorded globally.
  // The global note is always drained so one job's wall does not bleed into
  // the next job's bookkeeping.
  function quotaBehind(error = null, noted = null) {
    const recorded = noted ?? takeQuotaExhaustion();
    if (error?.quotaExhausted) {
      return { message: error.message, resetAt: error.quotaResetAt ?? recorded?.resetAt ?? null };
    }
    const detected = error ? detectQuotaExhaustion(error.message) : null;
    if (detected) return { ...detected, resetAt: detected.resetAt ?? recorded?.resetAt ?? null };
    return recorded;
  }

  // An out-of-tokens report on a job that belongs to somebody: their account
  // is what ran dry, so their account is what pauses — everyone else's queue
  // keeps moving. Their queued jobs wait via heldForAccountPause below.
  async function pauseForUserQuota(userId, provider, quota) {
    const resetAt =
      quota.resetAt && quota.resetAt > Date.now() ? quota.resetAt : Date.now() + quotaPauseMs;
    const until = new Date(resetAt);
    const reason =
      quota.message || `the ${provider} subscription reported it is out of tokens`;
    await pauseAccount(db, userId, provider, { until, reason });
    accountPauseCache = { at: 0, ids: accountPauseCache.ids.add(userId) };
    log(`user ${userId}'s ${provider} account paused until ${until.toISOString()}: ${reason}`);
    bus?.publish(userId, {
      kind: 'llm_account',
      event: 'paused',
      provider,
      paused: true,
      until: until.toISOString(),
      reason,
    });
    return until;
  }

  // Users whose LLM account is paused for quota, cached the same way (and
  // for the same reason) as heldForBudget below. The sweep also clears
  // pauses whose time has come, announcing each to its owner.
  let accountPauseCache = { at: 0, ids: new Set() };
  async function heldForAccountPause() {
    if (Date.now() - accountPauseCache.at < budgetCacheMs) return accountPauseCache.ids;
    try {
      const { held, resumed } = await sweepAccountPauses(db);
      for (const account of resumed) {
        log(`user ${account.user_id}'s ${account.provider} account pause expired; their jobs resume`);
        bus?.publish(account.user_id, {
          kind: 'llm_account',
          event: 'resumed',
          provider: account.provider,
          paused: false,
          until: null,
          reason: '',
        });
      }
      accountPauseCache = { at: Date.now(), ids: held };
      return held;
    } catch (e) {
      log(`could not read LLM account pauses: ${e.message}`);
      return new Set();
    }
  }

  // Users who have spent their token allowance. Their queued work waits where
  // it is rather than failing: the window rolls forward on its own, and a job
  // that was legitimately queued should still run when it does. Logged once
  // per user per drought so the reason is in the log without being in it a
  // thousand times.
  //
  // The answer is held for a moment rather than recomputed on every claim: a
  // pool of runners draining a queue asks many times a second, and this
  // cannot meaningfully change that fast — the window it is measured over is
  // a day at the shortest. Being a moment stale costs at most one more job's
  // worth of overspend.
  const announcedExhausted = new Set();
  let exhaustedCache = { at: 0, ids: new Set() };
  async function heldForBudget() {
    if (Date.now() - exhaustedCache.at < budgetCacheMs) return exhaustedCache.ids;
    let exhausted;
    try {
      exhausted = await exhaustedUserIds(db);
    } catch (e) {
      // Budgets are a limit on work, not a prerequisite for it.
      log(`could not read token budgets: ${e.message}`);
      return new Set();
    }
    for (const userId of exhausted) {
      if (!announcedExhausted.has(userId)) {
        announcedExhausted.add(userId);
        log(`user ${userId} has spent their token budget; their queued jobs wait`);
      }
    }
    for (const userId of [...announcedExhausted]) {
      if (!exhausted.has(userId)) {
        announcedExhausted.delete(userId);
        log(`user ${userId} is inside their token budget again`);
      }
    }
    exhaustedCache = { at: Date.now(), ids: exhausted };
    return exhausted;
  }

  async function claimNextJob() {
    const { Job } = db.models;
    const exhausted = await heldForBudget();
    const paused = await heldForAccountPause();
    // A page of the queue rather than one row: the oldest job might belong to
    // a user who is out of tokens while the one behind it does not, and the
    // second one should still run. The page is filtered here rather than in
    // SQL because "not one of these users, or nobody in particular" is
    // precisely the OR-inside-AND predicate the test database mis-evaluates.
    const pageSize = 50;
    for (let offset = 0; ; offset += pageSize) {
      const page = await Job.findAll({
        where: { status: 'pending' },
        order: [['id', 'ASC']],
        limit: pageSize,
        offset,
      });
      if (page.length === 0) return null;
      for (const next of page) {
        if (next.user_id && (exhausted.has(next.user_id) || paused.has(next.user_id))) continue;
        // Concurrent workers can race for the same pending row; the guarded
        // update decides the winner and the loser moves on to the next row.
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
      if (page.length < pageSize) return null;
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
    await resetJobTarget(db, job, status, message);
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

  const handlers = createHandlers(db, {
    manualsDir,
    exportsDir,
    capturesDir,
    panelsDir,
    fetchImpl,
    renderImpl,
    extractImpl,
  });

  // Process a single pending job if there is one. Returns the finished job row
  // or null. Exposed for tests and for the poll loop.
  async function tick() {
    if (await queuePaused()) return null;
    const job = await claimNextJob();
    if (!job) return null;
    return runJob(job);
  }

  // The row stopped being 'running' underneath us: the user stopped the job,
  // or deleted it outright. Either way its result is discarded — the row (if
  // there still is one) already says what the user asked for.
  async function abandoned(job, owners, outcome) {
    log(`job ${job.id} (${job.type}) ${outcome}, but it was stopped or deleted — discarding`);
    const row = await db.models.Job.findByPk(job.id);
    if (!row) return null;
    const plain = { ...row.get({ plain: true }), ...(await jobLabels(job)) };
    publish(owners, 'progress', plain, `job was stopped; the ${outcome} result was discarded`);
    return plain;
  }

  async function runJob(job) {
    const owners = await jobOwners(job);
    const labels = await jobLabels(job);
    Object.assign(job, labels);
    const progress = (message) => publish(owners, 'progress', job, message);

    held.set(job.id, job);
    publish(owners, 'started', job, `attempt ${job.attempts}`);
    // Which provider this job runs, whose credentials it runs on, and any
    // quota wall its own CLI runs reported — visible to the catch/finally
    // arms because they act on all three.
    let settings = null;
    let runtime = null;
    let notedQuota = null;
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`Unknown job type: ${job.type}`);
      const ownerUser = owners[0] ? await db.models.User.findByPk(owners[0]) : null;
      settings = await getLlmSettings(db, job.type, ownerUser);
      // Model runs happen on the job owner's own authorized account — there
      // is no shared login to fall back to. import and export_rack are the
      // two types that never call the model; everything else may, and fails
      // for good (not three times) when no account is connected, because no
      // retry will conjure one.
      if (job.type !== 'import' && job.type !== 'export_rack') {
        const account = ownerUser && (await getAccount(db, ownerUser.id, settings.provider));
        if (!account) {
          const missing = new Error(
            `no ${settings.provider} account is connected for this user — ` +
              'authorize the app under Account → LLM provider, then retry the job'
          );
          missing.permanent = true;
          throw missing;
        }
        runtime = await accountRuntime(db, account, { dataDir: llmDataDir });
      }
      // Every CLI run this job makes is billed to whoever caused the job —
      // including the runs of an attempt that goes on to fail, because those
      // tokens were spent too.
      const backend = backendFactory(settings, {
        env: runtime?.env ?? null,
        onQuota: (quota) => {
          notedQuota = quota;
        },
        onUsage: (usage) =>
          recordUsage(db, usage, {
            userId: owners[0] ?? null,
            jobId: job.id,
            jobType: job.type,
          }),
      });
      // The handler is raced rather than aborted: it has no cancellation to
      // offer, so the attempt is given up on and the runner freed. Whatever it
      // was waiting for is left to finish and be ignored.
      const limitMs = attemptTimeoutMs(jobTimeoutMs, job.attempts);
      await withTimeout(
        handler(job, backend, progress),
        limitMs,
        `job exceeded its ${Math.round(limitMs / 60000)} minute time limit`
      );
      // Guarded on the row still being 'running': the user can stop (or
      // delete) a job while its runner is mid-flight, and the outcome of work
      // they cancelled must not put the row back on the board.
      const [, doneRows] = await db.models.Job.update(
        { status: 'complete', error: null },
        { where: { id: job.id, status: 'running' }, returning: true }
      );
      if (!doneRows || !doneRows[0]) return abandoned(job, owners, 'completed');
      const done = { ...doneRows[0].get({ plain: true }), ...labels };
      publish(owners, 'completed', done);
      // A job can spend the last of the subscription and still finish — the
      // manual search falls back to archive.org when the model will not run —
      // so the wall is acted on on the way out of a success too.
      const spent = quotaBehind(null, notedQuota);
      if (spent) {
        if (owners[0] && settings) await pauseForUserQuota(owners[0], settings.provider, spent);
        else await pauseForQuota(spent);
      }
      return done;
    } catch (e) {
      // Out of tokens is not this job's fault: every job of this user's runs
      // the same account and would fail the same way, three attempts each.
      // Pause that account (or, for work nobody owns, the whole queue) and
      // put this job back on the queue with its attempt refunded.
      const quota = quotaBehind(e, notedQuota);
      if (quota) {
        const until =
          owners[0] && settings
            ? await pauseForUserQuota(owners[0], settings.provider, quota)
            : await pauseForQuota(quota);
        const requeued = await requeue(
          job,
          `out of tokens; queued again for when the account resumes at ${until.toISOString()}: ${e.message}`,
          { refundAttempt: true }
        );
        return requeued || abandoned(job, owners, 'failed');
      }
      const status = e.permanent || job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const [, failedRows] = await db.models.Job.update(
        { status, error: e.message },
        { where: { id: job.id, status: 'running' }, returning: true }
      );
      if (!failedRows || !failedRows[0]) return abandoned(job, owners, 'failed');
      const failed = { ...failedRows[0].get({ plain: true }), ...labels };
      publish(owners, status === 'failed' ? 'failed' : 'progress', failed,
        status === 'failed' ? e.message : `attempt failed, will retry: ${e.message}`);
      return failed;
    } finally {
      held.delete(job.id);
      // codex rotates its tokens in the per-user home; keep the database's
      // copy current. Failing to sync must not fail the job — the stored
      // copy stands until a later run manages it.
      try {
        await runtime?.sync?.();
      } catch (e) {
        log(`could not sync LLM credentials after job ${job.id}: ${e.message}`);
      }
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
      // Nothing is claimed while the queue is paused (the provider is out of
      // tokens). The pause clears itself here once its time has passed, so
      // the next wake-up drains the queue that has been piling up.
      if (await queuePaused()) return;
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
        // quotaPaused is set the moment any runner in this process hits the
        // limit, so its siblings stop claiming immediately rather than each
        // spending a job of their own to find the same wall.
        while (!stopped && !quotaPaused) {
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
