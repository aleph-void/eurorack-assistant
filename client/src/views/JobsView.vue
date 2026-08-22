<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useJobsStore } from '../stores/jobs.js';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { describeJob } from '../jobLabels.js';

const jobs = useJobsStore();
// Own token budget, when there is one. A user whose allowance is spent has
// jobs sitting in the queue for a reason nothing else on the page explains.
const budget = ref(null);
const periodNames = { day: '24 hours', week: '7 days', month: '30 days' };
const error = ref('');
const retryingAll = ref(false);
const stoppingAll = ref(false);
const deletingAll = ref(false);
const removingCancelled = ref(false);
const resuming = ref(false);
const feed = ref(null);

// The store prepends new events. Without resetting the viewport, a feed that
// is receiving updates while it is scrolled can stop between rows, leaving a
// clipped line at the top (and hiding the newest progress above it).
watch(
  () => jobs.feed[0],
  async () => {
    await nextTick();
    if (feed.value) feed.value.scrollTop = 0;
  }
);

// When the paused queue starts again by itself, in the reader's own clock.
const resumesAt = computed(() => {
  const at = jobs.queue.until ? new Date(jobs.queue.until) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : null;
});

// Same, for the viewer's own LLM account pause.
const llmResumesAt = computed(() => {
  const at = jobs.llmPause.until ? new Date(jobs.llmPause.until) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : null;
});

async function retry(job) {
  error.value = '';
  try {
    await jobs.retry(job.id);
  } catch (e) {
    error.value = e.message;
  }
}

// The page below the one showing. Failing to fetch it leaves what is already
// on screen alone — the list is still true, just shorter than the queue.
async function loadMore() {
  error.value = '';
  try {
    await jobs.loadMore();
  } catch (e) {
    error.value = e.message;
  }
}

async function retryAll() {
  error.value = '';
  retryingAll.value = true;
  try {
    await jobs.retryAll();
  } catch (e) {
    error.value = e.message;
  } finally {
    retryingAll.value = false;
  }
}

async function stop(job) {
  error.value = '';
  try {
    await jobs.stop(job.id);
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(job) {
  const ok = await dialog.confirm({
    title: 'Delete job',
    message: `Delete job ${job.id} (${job.type})? Its history and any error are lost.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await jobs.remove(job.id);
  } catch (e) {
    error.value = e.message;
  }
}

async function stopAll() {
  const ok = await dialog.confirm({
    title: 'Stop all jobs',
    message:
      `Take all ${jobs.stoppableJobs.length} queued and running job(s) off the queue? ` +
      'Work already in flight finishes in the background but its result is discarded.',
    confirmLabel: 'Stop All',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  stoppingAll.value = true;
  try {
    await jobs.stopAll();
  } catch (e) {
    error.value = e.message;
  } finally {
    stoppingAll.value = false;
  }
}

async function deleteAll() {
  const ok = await dialog.confirm({
    title: 'Delete all jobs',
    message: `Delete all ${jobs.ownJobs.length} of your job(s)? Anything still queued or running is stopped first.`,
    confirmLabel: 'Delete All',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  deletingAll.value = true;
  try {
    await jobs.deleteAll();
  } catch (e) {
    error.value = e.message;
  } finally {
    deletingAll.value = false;
  }
}

async function removeCancelled() {
  const ok = await dialog.confirm({
    title: 'Remove cancelled jobs',
    message: `Delete all ${jobs.cancelledJobs.length} cancelled job(s)? Their history and any error are lost.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  removingCancelled.value = true;
  try {
    await jobs.removeCancelled();
  } catch (e) {
    error.value = e.message;
  } finally {
    removingCancelled.value = false;
  }
}

// Start the queue again before its limit is due to lift — for a subscription
// that was topped up, or a pause the user disagrees with.
async function resumeQueue() {
  error.value = '';
  resuming.value = true;
  try {
    await jobs.resumeQueue();
  } catch (e) {
    error.value = e.message;
  } finally {
    resuming.value = false;
  }
}

const resumingLlm = ref(false);
async function resumeLlm() {
  error.value = '';
  resumingLlm.value = true;
  try {
    await jobs.resumeLlm();
  } catch (e) {
    error.value = e.message;
  } finally {
    resumingLlm.value = false;
  }
}

onMounted(async () => {
  // The account pause is a nicety beside the job list — a page that cannot
  // read it still renders everything else.
  jobs.fetchLlmPause().catch(() => {});
  try {
    await jobs.fetchJobs();
    await jobs.fetchQueue();
    // Only a real ceiling is worth a line on the page; a zero limit is the
    // shipped "no budget" state and says nothing.
    const status = await api.get('/api/usage/me');
    if (Number(status?.limit) > 0) {
      budget.value = { used: 0, remaining: 0, period: 'month', exhausted: false, ...status };
    }
  } catch (e) {
    error.value = e.message;
  }
});
</script>

<template>
  <h1>Background jobs</h1>
  <p v-if="error" class="error">{{ error }}</p>

  <!-- The queue stopped itself: the provider says there are no tokens left,
       and everything queued would fail the same way. It starts again on its
       own at the reset time; Resume overrides that. -->
  <div v-if="jobs.queue.paused" class="panel paused" data-test="queue-paused">
    <p>
      <strong>The job queue is paused</strong> — the LLM provider reported that it is out of
      tokens. Queued jobs stay where they are and run when it resumes.
    </p>
    <p v-if="jobs.queue.reason" class="muted">{{ jobs.queue.reason }}</p>
    <div class="actions">
      <p class="muted push">
        <template v-if="resumesAt">Resumes on its own at {{ resumesAt }}.</template>
      </p>
      <button class="secondary" :disabled="resuming" data-test="resume-queue" @click="resumeQueue">
        {{ resuming ? 'Resuming…' : 'Resume Now' }}
      </button>
    </div>
  </div>

  <!-- The viewer's own LLM account hit its provider's token wall. Only their
       jobs wait — everyone runs on their own subscription — so this banner is
       personal in a way the queue pause above is not. -->
  <div v-if="jobs.llmPause.paused" class="panel paused" data-test="llm-paused">
    <p>
      <strong>Your {{ jobs.llmPause.provider }} account is out of tokens</strong> — your queued
      jobs stay where they are and run when it resumes. Other users are unaffected.
    </p>
    <p v-if="jobs.llmPause.reason" class="muted">{{ jobs.llmPause.reason }}</p>
    <div class="actions">
      <p class="muted push">
        <template v-if="llmResumesAt">Resumes on its own at {{ llmResumesAt }}.</template>
      </p>
      <button class="secondary" :disabled="resumingLlm" data-test="resume-llm" @click="resumeLlm">
        {{ resumingLlm ? 'Resuming…' : 'Resume Now' }}
      </button>
    </div>
  </div>

  <!-- A budget is only worth showing to the user it applies to, and only when
       one applies at all. Spent is the interesting case: their queued jobs are
       waiting and nothing else on this page would say so. -->
  <div v-if="budget" class="panel" :class="{ paused: budget.exhausted }" data-test="budget">
    <p v-if="budget.exhausted" style="margin: 0 0 0.4rem">
      <strong>Your token budget is spent</strong> — {{ budget.used.toLocaleString() }} of
      {{ budget.limit.toLocaleString() }} in the last {{ periodNames[budget.period] || 'window' }}.
      Jobs already queued wait here and run as the window rolls forward; new work is refused until
      then. An admin can raise the allowance.
    </p>
    <p v-else class="muted" style="margin: 0">
      Token budget: {{ budget.used.toLocaleString() }} of {{ budget.limit.toLocaleString() }} spent
      in the last {{ periodNames[budget.period] || 'window' }},
      {{ budget.remaining.toLocaleString() }} left.
    </p>
  </div>

  <details open class="panel">
    <summary>
      <h2>Live progress</h2>
    </summary>
    <div class="panel-body">
      <!-- The feed is only ever what this page has seen since it opened, so
           clearing it is a local wipe — a way to watch the next job without
           the last one's lines above it. -->
      <div class="actions end spaced" data-test="feed-actions">
        <button
          class="secondary"
          :disabled="jobs.feed.length === 0"
          data-test="clear-feed"
          @click="jobs.clearFeed()"
        >
          Clear live log
        </button>
      </div>
      <div ref="feed" class="feed" data-test="feed">
        <div v-for="(line, i) in jobs.feed" :key="i" class="feed-line">
          <span class="muted">[job {{ line.jobId }} · {{ line.type }}]</span> {{ line.message }}
        </div>
        <div v-if="jobs.feed.length === 0" class="muted">
          No live events yet — updates stream here while jobs run.
        </div>
      </div>
    </div>
  </details>

  <div class="panel">
    <!-- Whole-list actions on one bar, over the viewer's own jobs only: Retry
         appears while something has failed, Stop All while there is something
         to stop, Delete All while they have anything listed at all. -->
    <div
      v-if="jobs.ownJobs.length > 0 || jobs.failedJobs.length > 0"
      class="actions end spaced"
      data-test="job-bulk-actions"
    >
      <p v-if="jobs.failedJobs.length > 0" class="muted push">
        {{ jobs.failedJobs.length }} failed job(s) can be retried.
      </p>
      <button
        v-if="jobs.failedJobs.length > 0"
        class="secondary"
        :disabled="retryingAll"
        data-test="retry-all"
        @click="retryAll"
      >
        {{ retryingAll ? 'Retrying…' : `Retry all failed (${jobs.failedJobs.length})` }}
      </button>
      <template v-if="jobs.ownJobs.length > 0">
        <button
          v-if="jobs.stoppableJobs.length > 0"
          class="secondary"
          :disabled="stoppingAll"
          data-test="stop-all"
          @click="stopAll"
        >
          {{ stoppingAll ? 'Stopping…' : `Stop All (${jobs.stoppableJobs.length})` }}
        </button>
        <button
          v-if="jobs.cancelledJobs.length > 0"
          class="secondary"
          :disabled="removingCancelled"
          data-test="remove-cancelled"
          @click="removeCancelled"
        >
          {{ removingCancelled ? 'Removing…' : `Remove Cancelled (${jobs.cancelledJobs.length})` }}
        </button>
        <button class="danger" :disabled="deletingAll" data-test="delete-all" @click="deleteAll">
          {{ deletingAll ? 'Deleting…' : 'Delete All' }}
        </button>
      </template>
    </div>
    <div class="table-wrap">
      <table data-test="job-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Type</th>
            <th>Target</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in jobs.jobs" :key="job.id">
            <td data-label="#">{{ job.id }}</td>
            <td data-label="Type">{{ job.type }}</td>
            <td data-label="Target">{{ describeJob(job) }}</td>
            <td data-label="Status">
              <span class="badge" :class="job.status">{{ job.status }}</span>
              <!-- Running, but its worker died holding it. -->
              <span v-if="job.stalled" class="badge failed" :data-test="`stalled-${job.id}`">
                stalled
              </span>
            </td>
            <td data-label="Attempts">{{ job.attempts }}</td>
            <td data-label="Error" class="muted">{{ job.error || '' }}</td>
            <!-- Up to four controls share this cell (Download, Retry, Stop,
                 Delete). The cell claims only the width they need and the bar
                 inside holds them on one line: the error column beside it
                 takes everything else, and a wrapping bar stacks them. -->
            <td class="actions-cell">
              <div class="actions nowrap">
                <!-- Finished exports normally download themselves; the link
                     covers a missed event (page closed). It dies once used —
                     the server deletes the zip after serving it. -->
                <a
                  v-if="job.download && job.status === 'complete'"
                  :href="job.download"
                  :data-test="`download-${job.id}`"
                >
                  Download
                </a>
                <button
                  v-if="job.status === 'failed' || job.stalled"
                  class="secondary"
                  :data-test="`retry-${job.id}`"
                  @click="retry(job)"
                >
                  Retry
                </button>
                <!-- Owner-only: an admin sees everyone's jobs but may not stop
                     or delete work someone else is waiting on. -->
                <button
                  v-if="job.own !== false && (job.status === 'pending' || job.status === 'running')"
                  class="secondary"
                  :data-test="`stop-${job.id}`"
                  @click="stop(job)"
                >
                  Stop
                </button>
                <button
                  v-if="job.own !== false"
                  class="danger"
                  :data-test="`delete-${job.id}`"
                  @click="remove(job)"
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="jobs.jobs.length === 0" class="muted">No jobs yet.</p>
    <!-- The list is the newest page of the queue's history, not all of it: a
         job row outlives the work it describes, so an account that has been
         running imports for a year has tens of thousands of them. The line
         says which part of the list is on screen; the button fetches the
         page below it. -->
    <div v-else-if="jobs.hasMore || jobs.jobs.length < jobs.total" class="paging">
      <span class="muted" data-test="job-count">
        Showing {{ jobs.jobs.length }} of {{ jobs.total }}
      </span>
      <button
        v-if="jobs.hasMore"
        class="secondary"
        :disabled="jobs.loadingMore"
        data-test="load-more"
        @click="loadMore"
      >
        {{ jobs.loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The count and the button that fetches the next page sit on one line under
   the table, the way the toolbar sits over it. */
.paging {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: 0.75rem;
}

/* A paused queue is not an error, but it explains everything else on the
   page, so it reads as the first thing rather than as another panel. */
.paused {
  border-color: var(--danger);
  background: rgba(248, 113, 113, 0.08);
}
</style>
