// When the queue — or one account's share of it — has to wait.
//
// Three different reasons work stops, each with its own blast radius:
//
//   * an exhausted subscription on UNOWNED work stops the whole queue, since
//     every job left in it runs the same provider and would fail the same
//     way, three attempts at a time;
//   * an exhausted subscription on somebody's own account pauses THAT
//     account — everyone else's queue keeps moving;
//   * a user over their token budget has their queued jobs WAIT rather than
//     fail, so the work is still there when the budget rolls over.
//
// Split out of jobs/worker.js, which is the queue engine itself.

import { detectQuotaExhaustion, takeQuotaExhaustion } from '../services/llm.js';
import { exhaustedUserIds } from '../services/budgets.js';
import { pauseAccount, sweepAccountPauses } from '../services/llmAccounts.js';
import { getQueuePause, pauseQueue, resumeQueue } from '../services/config.js';

// `publishQueue` announces a whole-queue pause to everyone (jobs/jobEvents.js);
// `quotaPauseMs` is how long to sleep when the provider will not say when the
// limit lifts.
export function createJobPauses(
  db,
  {
    bus = null,
    log = () => {},
    publishQueue,
    quotaPauseMs,
    // How long the set of out-of-tokens users is reused for (see
    // heldForBudget). Tests that change a budget and expect the very next
    // claim to see it set this to 0.
    budgetCacheMs = 2000,
  }
) {
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

  return {
    // Set while this process knows the queue is paused, so the runners
    // mid-drain stop claiming without going back to the database per job.
    isQuotaPaused: () => quotaPaused,
    queuePaused,
    pauseForQuota,
    quotaBehind,
    pauseForUserQuota,
    heldForAccountPause,
    heldForBudget,
  };
}
