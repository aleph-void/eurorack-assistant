<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

const config = ref(null);
const provider = ref('claude');
const model = ref('');
const importWorkers = ref(4);
const budgetDefault = ref(0);
const budgetPeriod = ref('month');
const youtubeApiKey = ref('');
const smtpUrl = ref('');
const smtpFrom = ref('');
const alertEmail = ref('');
const mailResult = ref('');
const mailError = ref('');
const mailBusy = ref(false);
const error = ref('');
const saved = ref(false);
const busy = ref(false);

const knownModels = computed(() => config.value?.known_models?.[provider.value] || []);
const defaultModel = computed(() => config.value?.default_models?.[provider.value] || '');
onMounted(async () => {
  try {
    config.value = await api.get('/api/config');
    provider.value = config.value.llm_provider;
    model.value = config.value.llm_model;
    importWorkers.value = Number(config.value.import_workers);
    budgetDefault.value = Number(config.value.token_budget_default) || 0;
    budgetPeriod.value = config.value.token_budget_period || 'month';
    youtubeApiKey.value = config.value.youtube_api_key || '';
    smtpUrl.value = config.value.smtp_url || '';
    smtpFrom.value = config.value.smtp_from || '';
    alertEmail.value = config.value.alert_email || '';
  } catch (e) {
    error.value = e.message;
  }
});

async function save() {
  error.value = '';
  saved.value = false;
  busy.value = true;
  try {
    config.value = { ...config.value, ...(await api.put('/api/config', {
      llm_provider: provider.value,
      llm_model: model.value,
      import_workers: importWorkers.value,
      token_budget_default: budgetDefault.value,
      token_budget_period: budgetPeriod.value,
      youtube_api_key: youtubeApiKey.value,
      smtp_url: smtpUrl.value,
      smtp_from: smtpFrom.value,
      alert_email: alertEmail.value,
    })) };
    saved.value = true;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

// A message through the SAVED settings: the server refusing the login is
// news to have today, not on the night a backup fails.
async function sendTestMail() {
  mailResult.value = '';
  mailError.value = '';
  mailBusy.value = true;
  try {
    const result = await api.post('/api/config/mail-test');
    mailResult.value = `Test message sent to ${result.to}.`;
  } catch (e) {
    mailError.value = e.message;
  } finally {
    mailBusy.value = false;
  }
}
</script>

<template>
  <h1>Configuration</h1>
  <div class="panel">
    <p class="muted">
      Questions, manual research, and manual analysis are sent to this provider by default; users
      can pick a different provider for themselves. Every user runs on their own account,
      connected under Account &rarr; LLM provider — the provider CLI (<code>claude</code> or
      <code>codex</code>) only needs to be installed on the server, not logged in.
    </p>
    <form @submit.prevent="save">
      <label for="provider">Provider</label>
      <select id="provider" v-model="provider" data-test="provider">
        <option v-for="p in config?.providers || ['claude', 'codex']" :key="p" :value="p">
          {{ p === 'claude' ? 'Claude Code CLI' : 'Codex CLI' }}
        </option>
      </select>

      <label for="model">Model (blank = provider default{{ defaultModel ? `: ${defaultModel}` : '' }})</label>
      <input id="model" v-model="model" data-test="model" list="known-models" />
      <datalist id="known-models">
        <option v-for="m in knownModels" :key="m" :value="m" />
      </datalist>

      <label for="import-workers">Import job workers (jobs processed in parallel)</label>
      <input
        id="import-workers"
        v-model.number="importWorkers"
        data-test="import-workers"
        type="number"
        min="1"
        step="1"
        required
      />

      <fieldset>
        <legend>Token budget</legend>
        <p class="muted" style="margin-top: 0">
          What one user may spend across their LLM jobs in a rolling window. 0 is no limit,
          which is how the app ships. Admins are never limited, and a user's own allowance (set on
          the Users page) overrides this one. Work already queued waits for the window to roll
          forward rather than failing.
        </p>
        <label for="token-budget">Tokens per user (0 = unlimited)</label>
        <input
          id="token-budget"
          v-model.number="budgetDefault"
          data-test="token-budget-default"
          type="number"
          min="0"
          step="1000"
          required
        />
        <label for="token-period">Window</label>
        <select id="token-period" v-model="budgetPeriod" data-test="token-budget-period">
          <option value="day">last 24 hours</option>
          <option value="week">last 7 days</option>
          <option value="month">last 30 days</option>
        </select>
      </fieldset>

      <fieldset>
        <legend>YouTube</legend>
        <p class="muted" style="margin-top: 0">
          A YouTube Data API v3 key speeds up scanning a channel for videos about a rack's
          modules (Modules page, with a rack selected) and lets the scan match video
          descriptions. Without a key the scan still works — it falls back to yt-dlp and
          matches titles only. Attaching individual video links never needs a key.
        </p>
        <label for="youtube-api-key">API key</label>
        <input
          id="youtube-api-key"
          v-model="youtubeApiKey"
          data-test="youtube-api-key"
          autocomplete="off"
          placeholder="AIza…"
        />
      </fieldset>

      <fieldset>
        <legend>Alerts</legend>
        <p class="muted" style="margin-top: 0">
          Where the app sends word of something you are not looking at: a daily backup that
          failed (see <RouterLink to="/admin/backups">Backups</RouterLink>). Mail goes through
          the SMTP server named here — <code>smtp://user:password@host:587</code> for STARTTLS,
          <code>smtps://…:465</code> for TLS from the first byte. Blank means nothing is sent
          and the failure shows only in the app.
        </p>
        <label for="alert-email">Alert address</label>
        <input
          id="alert-email"
          v-model="alertEmail"
          data-test="alert-email"
          type="email"
          autocomplete="off"
          placeholder="you@example.com"
        />
        <label for="smtp-url">SMTP URL</label>
        <input
          id="smtp-url"
          v-model="smtpUrl"
          data-test="smtp-url"
          autocomplete="off"
          placeholder="smtps://user:password@smtp.example.com:465"
        />
        <label for="smtp-from">Sender address (blank = the SMTP login)</label>
        <input
          id="smtp-from"
          v-model="smtpFrom"
          data-test="smtp-from"
          type="email"
          autocomplete="off"
          placeholder="rack@example.com"
        />
        <p class="muted">
          <button
            type="button"
            class="secondary"
            :disabled="mailBusy"
            data-test="send-test-mail"
            @click="sendTestMail"
          >
            {{ mailBusy ? 'Sending…' : 'Send a test message' }}
          </button>
          — uses the settings as last saved.
        </p>
        <p v-if="mailResult" class="success" data-test="mail-result">{{ mailResult }}</p>
        <p v-if="mailError" class="error" data-test="mail-error">{{ mailError }}</p>
      </fieldset>

      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <p v-if="saved" class="success" data-test="saved">Configuration saved.</p>
      <button type="submit" :disabled="busy" data-test="save">Save</button>
    </form>
  </div>
</template>
