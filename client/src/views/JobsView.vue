<script setup>
import { onMounted, ref } from 'vue';
import { useJobsStore } from '../stores/jobs.js';

const jobs = useJobsStore();
const error = ref('');
const retryingAll = ref(false);

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

  <div class="panel">
    <h2>Live progress</h2>
    <div class="feed" data-test="feed">
      <div v-for="(line, i) in jobs.feed" :key="i">
        <span class="muted">[job {{ line.jobId }} · {{ line.type }}]</span> {{ line.message }}
      </div>
      <div v-if="jobs.feed.length === 0" class="muted">
        No live events yet — updates stream here while jobs run.
      </div>
    </div>
  </div>

  <div class="panel">
    <!-- Only worth offering once a single Retry click is not enough. -->
    <div v-if="jobs.failedJobs.length > 1" class="row" style="align-items: baseline">
      <p class="muted" style="margin: 0">{{ jobs.failedJobs.length }} failed jobs.</p>
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
          <td><span class="badge" :class="job.status">{{ job.status }}</span></td>
          <td>{{ job.attempts }}</td>
          <td class="muted">{{ job.error || '' }}</td>
          <td>
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
              v-if="job.status === 'failed'"
              class="secondary"
              style="margin: 0"
              :data-test="`retry-${job.id}`"
              @click="retry(job)"
            >
              Retry
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="jobs.jobs.length === 0" class="muted">No jobs yet.</p>
  </div>
</template>
