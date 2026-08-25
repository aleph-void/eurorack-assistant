<script setup>
// What the browser refused, and did not tell anybody but us.
//
// The content security policy (nginx/csp.conf for the app's pages,
// server/src/csp.js for the API) is enforced in the browser, so the browser is
// the only witness to what it stopped. This page is the other end of the
// policy's report-uri: every violation any visitor's browser reported, one row
// per distinct complaint with the number of times it has arrived.
//
// EVERY FIELD HERE IS WRITTEN BY A STRANGER. The reporting endpoint takes no
// session — it cannot, the login page is where a policy first bites — so
// anyone on the internet can post a violation naming any URL they like.
// Nothing on this page is rendered as anything but text, and nothing is a
// link: a blocked-uri that reads like a URL is a string the reporter chose.

import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';

const PAGE = 100;

const reports = ref([]);
// The list is one PAGE, newest first, exactly as the job list is: a policy
// tightened against a live app can name hundreds of distinct violations in an
// afternoon. `total` is the number of distinct violations, `reported` the
// number of times they have been reported between them.
const total = ref(0);
const reported = ref(0);
const hasMore = ref(false);
const nextBefore = ref(null);
const loadingMore = ref(false);
const loading = ref(true);
const error = ref('');
const clearing = ref(false);

// A row's referrer, the browser that saw it, and the policy that browser was
// enforcing — built the first time the row is opened, like every other
// section in the app that starts closed (lazyPanel.js).
const openedRows = ref(new Set());
const onToggleRow = (id, event) => {
  if (event.target.open) openedRows.value = new Set(openedRows.value).add(id);
};

function applyPage(page, { append = false } = {}) {
  const rows = page?.reports ?? [];
  reports.value = append ? reports.value.concat(rows) : rows;
  total.value = page?.total ?? reports.value.length;
  reported.value = page?.reported ?? 0;
  hasMore.value = Boolean(page?.has_more);
  nextBefore.value = page?.next_before ?? null;
}

async function load() {
  loading.value = true;
  try {
    applyPage(await api.get(`/api/csp-reports?limit=${PAGE}`));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// The page below the one showing. Rows are ordered by when a violation was
// FIRST seen, which is what makes the cursor stable: a violation reported
// again while the reader is paging moves its count and its last-seen date, not
// its place in the list.
async function loadMore() {
  if (!hasMore.value || loadingMore.value) return;
  error.value = '';
  loadingMore.value = true;
  try {
    applyPage(await api.get(`/api/csp-reports?limit=${PAGE}&before=${nextBefore.value}`), {
      append: true,
    });
  } catch (e) {
    error.value = e.message;
  } finally {
    loadingMore.value = false;
  }
}

async function remove(report) {
  error.value = '';
  try {
    await api.delete(`/api/csp-reports/${report.id}`);
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// Emptying the table is how a fix is confirmed: clear it, deploy, and whatever
// comes back is still broken.
async function clearAll() {
  const ok = await dialog.confirm({
    title: 'Clear violation reports',
    message: `Delete all ${total.value} recorded violations? Browsers will report them again if they still happen.`,
    confirmLabel: 'Clear',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  clearing.value = true;
  try {
    await api.delete('/api/csp-reports');
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    clearing.value = false;
  }
}

const when = (value) => (value ? new Date(value).toLocaleString() : '');

// "at line 12, column 4 of /assets/index.js" in as few characters as the
// browser gave us — it often gives none.
function where(report) {
  if (!report.source_file) return '';
  const line = report.line_number ? `:${report.line_number}` : '';
  const column = report.line_number && report.column_number ? `:${report.column_number}` : '';
  return `${report.source_file}${line}${column}`;
}

onMounted(load);
</script>

<template>
  <h1>Policy violations</h1>
  <div class="panel">
    <p class="muted">
      Every page of this app is served under a content security policy that says
      where scripts, styles, pictures and connections may come from. When a browser
      refuses something, it reports what it refused here — so a policy that is too
      tight shows up as a list rather than as a page that quietly does not work.
      One row per distinct violation, however many times it has been reported.
    </p>
    <p class="muted">
      The reports are posted by browsers and are not authenticated: read every
      value below as something the reporter typed, not as a fact.
    </p>

    <p v-if="error" class="error" data-test="error">{{ error }}</p>
    <p v-if="loading" class="muted" data-test="loading">Loading…</p>
    <p v-else-if="!reports.length" class="muted" data-test="empty">
      Nothing has been reported. Either the policy fits the app, or no browser has
      met it yet.
    </p>

    <template v-else>
      <p class="muted" data-test="summary">
        {{ total }} distinct {{ total === 1 ? 'violation' : 'violations' }},
        reported {{ reported }} {{ reported === 1 ? 'time' : 'times' }} in all.
      </p>
      <div class="table-wrap">
        <table data-test="report-table">
          <thead>
            <tr>
              <th>Directive</th>
              <th>Blocked</th>
              <th>Page</th>
              <th>Reports</th>
              <th>Last seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="report in reports" :key="report.id">
              <tr :data-test="`report-${report.id}`">
                <td data-label="Directive">
                  <span class="badge failed">{{ report.directive || 'unknown' }}</span>
                  <!-- A report-only policy is a rehearsal: the browser let it
                       through and only said what it would have done. -->
                  <span
                    v-if="report.disposition === 'report'"
                    class="badge"
                    data-test="report-only"
                  >
                    report-only
                  </span>
                </td>
                <td data-label="Blocked">
                  <code>{{ report.blocked_uri || '—' }}</code>
                  <p v-if="report.script_sample" class="muted sample">{{ report.script_sample }}</p>
                </td>
                <td data-label="Page">
                  <code>{{ report.document_uri || '—' }}</code>
                  <!-- Where in our own code it happened, when the browser
                       knows: the line that asked for what was refused. -->
                  <p v-if="where(report)" class="muted sample">{{ where(report) }}</p>
                </td>
                <td data-label="Reports">{{ report.report_count }}</td>
                <td data-label="Last seen">{{ when(report.last_seen_at) }}</td>
                <td>
                  <button
                    class="secondary"
                    :data-test="`delete-${report.id}`"
                    @click="remove(report)"
                  >
                    Delete
                  </button>
                </td>
              </tr>
              <!-- The rest of the report, in a row of its own rather than a
                   sixth column: a policy is a paragraph long, and a column
                   holding one squeezes the URLs beside it to a letter a line. -->
              <tr>
                <td colspan="6">
                  <details :data-test="`more-${report.id}`" @toggle="onToggleRow(report.id, $event)">
                    <summary>More</summary>
                    <dl v-if="openedRows.has(report.id)" class="more">
                      <dt>First seen</dt>
                      <dd>{{ when(report.first_seen_at) }}</dd>
                      <dt>Referrer</dt>
                      <dd><code>{{ report.referrer || '—' }}</code></dd>
                      <dt>Browser</dt>
                      <dd>{{ report.user_agent || '—' }}</dd>
                      <dt>Policy it was enforcing</dt>
                      <dd><code>{{ report.original_policy || '—' }}</code></dd>
                    </dl>
                  </details>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div v-if="hasMore || reports.length < total" class="paging">
        <span class="muted" data-test="report-count">
          Showing {{ reports.length }} of {{ total }}
        </span>
        <button
          v-if="hasMore"
          class="secondary"
          :disabled="loadingMore"
          data-test="load-more"
          @click="loadMore"
        >
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </div>

      <button class="danger" :disabled="clearing" data-test="clear-all" @click="clearAll">
        {{ clearing ? 'Clearing…' : 'Clear all' }}
      </button>
    </template>
  </div>
</template>

<style scoped>
code {
  overflow-wrap: anywhere;
}

.paging {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: 0.75rem;
}

.sample {
  margin: 0.25rem 0 0;
  font-family: var(--font-mono);
  font-size: 0.85em;
  overflow-wrap: anywhere;
}

/* A blocked URI and the page it happened on are the two things being read
   here, and both are long: give them room before the short columns take it. */
td[data-label='Blocked'],
td[data-label='Page'] {
  min-width: 16rem;
}

.more {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.15rem 0.75rem;
  margin: 0.5rem 0 0;
  font-size: 0.9em;
}

.more dt {
  color: var(--muted);
}

.more dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
