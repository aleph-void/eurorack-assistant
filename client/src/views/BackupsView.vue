<script setup>
// What the daily backup reported, run by run.
//
// The backup is a script on the host (backup-to-s3.sh, run once a day by a
// systemd timer) and this page is how its outcome reaches the app: each run
// reports itself as it ends, and the record answers the two questions an
// admin has — did the last one work, and when did one last succeed. The
// same `problem` line is the banner over every page while the answer is bad.

import { computed, onMounted } from 'vue';
import { useBackupsStore } from '../stores/backups.js';

const backups = useBackupsStore();

const when = (value) => (value ? new Date(value).toLocaleString() : '—');

// A backup is tens of megabytes to tens of gigabytes; one unit each way.
function size(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} kB`;
}

const status = computed(() => backups.status);
const latest = computed(() => status.value?.latest || null);
const lastCompleted = computed(() => status.value?.last_completed || null);

// A failure nobody was mailed about is a failure only this page knows of,
// which is worth a line under the row: the fix is one page over.
const unalerted = computed(() => backups.runs.some((run) => run.status === 'failed' && !run.alerted));

onMounted(() => backups.load());
</script>

<template>
  <h1>Backups</h1>
  <div class="panel">
    <p class="muted">
      The daily backup — the database, the manuals, panels and recordings, and the key that
      decrypts the stored LLM credentials — is made on the host by
      <code>backup-to-s3.sh</code> and uploaded to S3, and each run reports how it ended here.
      A failure is also mailed to the alert address under Application Config, when one is set.
    </p>

    <p v-if="backups.loading && !status" class="muted" data-test="loading">Loading…</p>
    <template v-else-if="status">
      <p v-if="status.problem" class="error" data-test="problem">{{ status.problem }}</p>
      <p v-else-if="latest" class="success" data-test="healthy">
        The last backup succeeded on {{ when(latest.finished_at) }}.
      </p>
      <p v-else class="muted" data-test="never">
        No backup has reported yet. Turn daily backups on with
        <code>./install-backup.sh &lt;bucket&gt; --now</code> on the host; the first run shows
        up here when it ends.
      </p>
      <p v-if="status.problem && lastCompleted" class="muted" data-test="last-good">
        The last backup that succeeded is <code>{{ lastCompleted.name }}</code>, made
        {{ when(lastCompleted.finished_at) }}.
      </p>
      <p v-if="unalerted" class="muted" data-test="unalerted">
        A failure below was not mailed to anybody. Set an SMTP server and an alert address under
        <RouterLink to="/admin/config">Application Config</RouterLink> to be told of the next one.
      </p>

      <button class="secondary" :disabled="backups.loading" data-test="reload" @click="backups.load()">
        {{ backups.loading ? 'Reloading…' : 'Reload' }}
      </button>

      <div v-if="backups.runs.length" class="table-wrap">
        <table data-test="run-table">
          <thead>
            <tr>
              <th>Finished</th>
              <th>Outcome</th>
              <th>Backup</th>
              <th>Size</th>
              <th>Host</th>
              <th>What the script said</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in backups.runs" :key="run.id" :data-test="`run-${run.id}`">
              <td data-label="Finished">{{ when(run.finished_at) }}</td>
              <td data-label="Outcome">
                <span class="badge" :class="run.status" :data-test="`status-${run.id}`">
                  {{ run.status }}
                </span>
                <span v-if="run.status === 'failed' && run.alerted" class="muted small">
                  alert mailed
                </span>
              </td>
              <td data-label="Backup"><code>{{ run.name || '—' }}</code></td>
              <td data-label="Size">{{ size(run.size_bytes) }}</td>
              <td data-label="Host">{{ run.host || '—' }}</td>
              <!-- The tail of a host log: paths, bucket names and whatever the
                   upload error chose to say. Text, never markup. -->
              <td data-label="What the script said">
                <pre v-if="run.message" class="message">{{ run.message }}</pre>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="error" data-test="unavailable">The backup status could not be read.</p>
  </div>
</template>

<style scoped>
code {
  overflow-wrap: anywhere;
}

.small {
  display: block;
  font-size: 0.8em;
  margin-top: 0.2rem;
}

/* The message is a log tail: keep its lines, cap its height, and let a
   long line wrap rather than widen the table. */
.message {
  margin: 0;
  max-height: 12rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.8em;
}

td[data-label='What the script said'] {
  min-width: 18rem;
}
</style>
