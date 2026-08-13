<script setup>
import { onMounted, ref } from 'vue';
import { useJobsStore } from '../stores/jobs.js';
import { dialog } from '../dialog.js';

const jobs = useJobsStore();
const error = ref('');
const retryingAll = ref(false);
const stoppingAll = ref(false);
const deletingAll = ref(false);

function describe(job) {
  if (job.module_name) return `${job.module_manufacturer || ''} ${job.module_name}`.trim();
  if (job.question_prompt) return job.question_prompt;
  if (job.rack_name) return job.rack_name;
  return '';
}

async function retry(job) {
  error.value = '';
  try {
    await jobs.retry(job.id);
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

onMounted(async () => {
  try {
    await jobs.fetchJobs();
  } catch (e) {
    error.value = e.message;
  }
});
</script>

<template>
  <h1>Background jobs</h1>
  <p v-if="error" class="error">{{ error }}</p>

  <details open class="panel">
    <summary>
      <h2>Live progress</h2>
    </summary>
    <div class="panel-body">
      <div class="feed" data-test="feed">
        <div v-for="(line, i) in jobs.feed" :key="i">
          <span class="muted">[job {{ line.jobId }} · {{ line.type }}]</span> {{ line.message }}
        </div>
        <div v-if="jobs.feed.length === 0" class="muted">
          No live events yet — updates stream here while jobs run.
        </div>
      </div>
    </div>
  </details>

  <div class="panel">
    <!-- Only worth offering once a single Retry click is not enough. -->
    <div v-if="jobs.retryableJobs.length > 1" class="row" style="align-items: baseline">
      <p class="muted" style="margin: 0">{{ jobs.retryableJobs.length }} jobs need retrying.</p>
      <div class="shrink">
        <button
          class="secondary"
          style="margin: 0"
          :disabled="retryingAll"
          data-test="retry-all"
          @click="retryAll"
        >
          {{ retryingAll ? 'Retrying…' : 'Retry All' }}
        </button>
      </div>
    </div>

    <!-- Whole-list actions, over the viewer's own jobs only. Stop All appears
         while there is something to stop; Delete All while they have anything
         listed at all. -->
    <div
      v-if="jobs.ownJobs.length > 0"
      class="row"
      style="align-items: baseline; justify-content: flex-end"
    >
      <div class="shrink">
        <button
          v-if="jobs.stoppableJobs.length > 0"
          class="secondary"
          style="margin: 0"
          :disabled="stoppingAll"
          data-test="stop-all"
          @click="stopAll"
        >
          {{ stoppingAll ? 'Stopping…' : `Stop All (${jobs.stoppableJobs.length})` }}
        </button>
      </div>
      <div class="shrink">
        <button
          class="danger"
          style="margin: 0"
          :disabled="deletingAll"
          data-test="delete-all"
          @click="deleteAll"
        >
          {{ deletingAll ? 'Deleting…' : 'Delete All' }}
        </button>
      </div>
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
            <td>{{ job.id }}</td>
            <td>{{ job.type }}</td>
            <td>{{ describe(job) }}</td>
            <td>
              <span class="badge" :class="job.status">{{ job.status }}</span>
              <!-- Running, but its worker died holding it. -->
              <span v-if="job.stalled" class="badge failed" :data-test="`stalled-${job.id}`">
                stalled
              </span>
            </td>
            <td>{{ job.attempts }}</td>
            <td class="muted">{{ job.error || '' }}</td>
            <td class="job-actions">
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
                style="margin: 0"
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
                style="margin: 0"
                :data-test="`stop-${job.id}`"
                @click="stop(job)"
              >
                Stop
              </button>
              <button
                v-if="job.own !== false"
                class="danger"
                style="margin: 0"
                :data-test="`delete-${job.id}`"
                @click="remove(job)"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="jobs.jobs.length === 0" class="muted">No jobs yet.</p>
  </div>
</template>

<style scoped>
/* Up to four controls share this cell (Download, Retry, Stop, Delete); they
   wrap onto a second line rather than stretching the column on narrow
   screens. */
.job-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
</style>
