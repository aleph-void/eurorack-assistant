<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

// Everything on this page reads and writes /api/llm, which always answers
// with the same status object; each action simply replaces `status`.
const status = ref(null);
const error = ref('');
const notice = ref('');
const busy = ref(false);

// Settings form
const provider = ref('');
const model = ref('');
const jobModels = ref({});

// Claude authorization flow
const authorizeUrl = ref('');
const authCode = ref('');

// Paste-in credentials
const claudeToken = ref('');
const claudeApiKey = ref('');
const codexAuthJson = ref('');
const codexApiKey = ref('');

const effectiveProvider = computed(() => status.value?.effective_provider || 'claude');
const knownModels = computed(() => {
  const chosen = provider.value || effectiveProvider.value;
  return status.value?.known_models?.[chosen] || [];
});
const defaultModel = computed(() => {
  const chosen = provider.value || effectiveProvider.value;
  return status.value?.default_models?.[chosen] || '';
});
const jobTypes = computed(() => status.value?.llm_job_types || []);
const claude = computed(() => status.value?.accounts?.claude || null);
const codex = computed(() => status.value?.accounts?.codex || null);
const connectedForEffective = computed(
  () => !!status.value?.accounts?.[effectiveProvider.value]
);

const KIND_LABELS = {
  oauth: 'authorized account',
  token: 'setup token',
  api_key: 'API key',
  auth_json: 'pasted login (auth.json)',
};

function apply(next) {
  status.value = next;
  provider.value = next.llm_provider || '';
  model.value = next.llm_model || '';
  const models = {};
  for (const type of next.llm_job_types || []) {
    models[type] = next.llm_models?.[type] || '';
  }
  jobModels.value = models;
}

async function run(action, doing) {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    await action();
    if (doing) notice.value = doing;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

onMounted(() =>
  run(async () => {
    apply(await api.get('/api/llm'));
  })
);

const saveSettings = () =>
  run(async () => {
    apply(
      await api.put('/api/llm/settings', {
        llm_provider: provider.value,
        llm_model: model.value,
        llm_models: jobModels.value,
      })
    );
  }, 'Settings saved.');

const startClaudeAuth = () =>
  run(async () => {
    const { url } = await api.post('/api/llm/claude/oauth/start');
    authorizeUrl.value = url;
    authCode.value = '';
  });

const finishClaudeAuth = () =>
  run(async () => {
    apply(await api.post('/api/llm/claude/oauth/finish', { code: authCode.value }));
    authorizeUrl.value = '';
    authCode.value = '';
  }, 'Claude account authorized.');

const saveClaudeToken = () =>
  run(async () => {
    apply(await api.post('/api/llm/claude/token', { token: claudeToken.value }));
    claudeToken.value = '';
  }, 'Claude token saved.');

const saveCodexAuthJson = () =>
  run(async () => {
    apply(await api.post('/api/llm/codex/auth-json', { auth_json: codexAuthJson.value }));
    codexAuthJson.value = '';
  }, 'Codex login saved.');

const saveKey = (which, value) =>
  run(async () => {
    apply(await api.post(`/api/llm/${which}/api-key`, { api_key: value }));
    claudeApiKey.value = '';
    codexApiKey.value = '';
  }, 'API key saved.');

const disconnect = (which) =>
  run(async () => {
    apply(await api.delete(`/api/llm/${which}`));
  }, 'Account disconnected.');

const resume = (which) =>
  run(async () => {
    apply(await api.post(`/api/llm/${which}/resume`));
  }, 'Pause lifted; queued jobs will resume.');

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
</script>

<template>
  <h1>LLM provider</h1>
  <p class="muted">
    Questions, manual research and analysis run on your own account with the provider — the app
    never shares one subscription between users. Connect the account for the provider you use;
    jobs cannot run without one.
  </p>

  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="notice" class="muted" data-test="notice">{{ notice }}</p>

  <p
    v-if="status && !connectedForEffective"
    class="error"
    data-test="not-connected"
  >
    No {{ effectiveProvider }} account is connected — jobs that use the model will not run until
    you connect one below.
  </p>

  <div class="panel">
    <h2>Provider &amp; model</h2>
    <form @submit.prevent="saveSettings">
      <label for="llm-provider">Provider</label>
      <select id="llm-provider" v-model="provider" data-test="provider">
        <option value="">Site default ({{ status?.providers ? status.effective_provider : '…' }})</option>
        <option v-for="p in status?.providers || []" :key="p" :value="p">
          {{ p === 'claude' ? 'Claude Code CLI' : 'Codex CLI' }}
        </option>
      </select>

      <label for="llm-model">
        Model (blank = default{{ defaultModel ? `: ${defaultModel}` : '' }})
      </label>
      <input id="llm-model" v-model="model" data-test="model" list="my-known-models" />
      <datalist id="my-known-models">
        <option v-for="m in knownModels" :key="m" :value="m" />
      </datalist>

      <fieldset v-if="jobTypes.length">
        <legend>Model per job type (blank = model above)</legend>
        <template v-for="t in jobTypes" :key="t">
          <label :for="`my-model-${t}`">{{ t.replaceAll('_', ' ') }}</label>
          <input
            :id="`my-model-${t}`"
            v-model="jobModels[t]"
            :data-test="`my-model-${t}`"
            list="my-known-models"
          />
        </template>
      </fieldset>

      <button type="submit" :disabled="busy" data-test="save-settings">Save</button>
    </form>
  </div>

  <div class="panel" data-test="claude-panel">
    <h2>Claude account</h2>
    <p v-if="claude" class="muted" data-test="claude-status">
      Connected via {{ KIND_LABELS[claude.kind] || claude.kind }}
      <template v-if="claude.expires_at"> · token refreshes itself</template>
      · since {{ when(claude.created_at) }}
    </p>
    <p v-else class="muted" data-test="claude-status">Not connected.</p>

    <p v-if="claude?.paused_until" class="error" data-test="claude-paused">
      Out of tokens — your queued jobs wait until {{ when(claude.paused_until) }}
      <template v-if="claude.paused_reason"> ({{ claude.paused_reason }})</template>.
      <button type="button" :disabled="busy" data-test="claude-resume" @click="resume('claude')">
        Resume now
      </button>
    </p>

    <div v-if="!authorizeUrl">
      <button type="button" :disabled="busy" data-test="claude-authorize" @click="startClaudeAuth">
        {{ claude ? 'Re-authorize with Claude' : 'Authorize with Claude' }}
      </button>
    </div>
    <div v-else data-test="claude-auth-step">
      <ol>
        <li>
          <a :href="authorizeUrl" target="_blank" rel="noopener" data-test="claude-auth-link">
            Open claude.ai and approve the authorization
          </a>
          (log in with your own Claude subscription).
        </li>
        <li>Copy the code the page shows you and paste it here:</li>
      </ol>
      <form @submit.prevent="finishClaudeAuth">
        <label for="claude-auth-code">Authorization code</label>
        <input
          id="claude-auth-code"
          v-model="authCode"
          data-test="claude-auth-code"
          autocomplete="off"
          required
        />
        <button type="submit" :disabled="busy" data-test="claude-auth-finish">
          Finish authorization
        </button>
      </form>
    </div>

    <details class="expander">
      <summary>Paste a token from <code>claude setup-token</code> instead</summary>
      <div class="expander-body">
        <p class="muted">
          Run <code>claude setup-token</code> on any machine where Claude Code is logged in, and
          paste the <code>sk-ant-…</code> token it prints.
        </p>
        <form @submit.prevent="saveClaudeToken">
          <label for="claude-token">Token</label>
          <input id="claude-token" v-model="claudeToken" data-test="claude-token" autocomplete="off" required />
          <button type="submit" :disabled="busy" data-test="claude-token-save">Save token</button>
        </form>
      </div>
    </details>

    <details class="expander">
      <summary>Use an Anthropic API key instead</summary>
      <div class="expander-body">
        <form @submit.prevent="saveKey('claude', claudeApiKey)">
          <label for="claude-api-key">API key</label>
          <input id="claude-api-key" v-model="claudeApiKey" data-test="claude-api-key" autocomplete="off" required />
          <button type="submit" :disabled="busy">Save key</button>
        </form>
      </div>
    </details>

    <p v-if="claude">
      <button type="button" class="danger" :disabled="busy" data-test="claude-disconnect" @click="disconnect('claude')">
        Disconnect Claude account
      </button>
    </p>
  </div>

  <div class="panel" data-test="codex-panel">
    <h2>Codex account</h2>
    <p v-if="codex" class="muted" data-test="codex-status">
      Connected via {{ KIND_LABELS[codex.kind] || codex.kind }} · since {{ when(codex.created_at) }}
    </p>
    <p v-else class="muted" data-test="codex-status">Not connected.</p>

    <p v-if="codex?.paused_until" class="error" data-test="codex-paused">
      Out of tokens — your queued jobs wait until {{ when(codex.paused_until) }}.
      <button type="button" :disabled="busy" data-test="codex-resume" @click="resume('codex')">
        Resume now
      </button>
    </p>

    <p class="muted">
      The Codex CLI has no headless authorization: run <code>codex login</code> on your own
      machine, then paste the contents of <code>~/.codex/auth.json</code> here. The app keeps it
      fresh from then on.
    </p>
    <form @submit.prevent="saveCodexAuthJson">
      <label for="codex-auth-json">auth.json</label>
      <textarea
        id="codex-auth-json"
        v-model="codexAuthJson"
        data-test="codex-auth-json"
        rows="4"
        autocomplete="off"
        required
      ></textarea>
      <button type="submit" :disabled="busy" data-test="codex-auth-save">Save login</button>
    </form>

    <details class="expander">
      <summary>Use an OpenAI API key instead</summary>
      <div class="expander-body">
        <form @submit.prevent="saveKey('codex', codexApiKey)">
          <label for="codex-api-key">API key</label>
          <input id="codex-api-key" v-model="codexApiKey" data-test="codex-api-key" autocomplete="off" required />
          <button type="submit" :disabled="busy">Save key</button>
        </form>
      </div>
    </details>

    <p v-if="codex">
      <button type="button" class="danger" :disabled="busy" data-test="codex-disconnect" @click="disconnect('codex')">
        Disconnect Codex account
      </button>
    </p>
  </div>
</template>
