<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';

// The approval screen of the OAuth device flow: the oscilloscope shows a
// code, the user types (or follows a link with) it here, and approving mints
// the token the app is polling for.
const route = useRoute();
const code = ref('');
const pending = ref(null);
const error = ref('');
const done = ref('');
const busy = ref(false);
const name = ref('');

async function lookup() {
  error.value = '';
  done.value = '';
  pending.value = null;
  const value = String(code.value || '').trim();
  if (!value) return;
  busy.value = true;
  try {
    pending.value = await api.get(`/api/devices/authorizations/${encodeURIComponent(value)}`);
    name.value = pending.value.device_name || pending.value.client_name || 'Oscilloscope';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function decide(approve) {
  error.value = '';
  busy.value = true;
  try {
    const action = approve ? 'approve' : 'deny';
    await api.post(
      `/api/devices/authorizations/${encodeURIComponent(pending.value.user_code)}/${action}`,
      approve ? { name: name.value } : {}
    );
    done.value = approve
      ? 'Approved. The application should connect within a few seconds.'
      : 'Denied. The application will stop asking.';
    pending.value = null;
    code.value = '';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  // A device that can open a browser sends the user straight here with the
  // code already filled in.
  if (route.query.code) {
    code.value = String(route.query.code);
    lookup();
  }
});
</script>

<template>
  <h1>Link an oscilloscope</h1>
  <p class="muted">
    Enter the code your oscilloscope application is showing. It will be able to send this
    server waveform captures and tuner readings until you revoke it under
    <RouterLink to="/devices">Devices</RouterLink>.
  </p>

  <p v-if="error" class="error" data-test="error">{{ error }}</p>
  <p v-if="done" class="ok" data-test="done">{{ done }}</p>

  <div class="panel">
    <form @submit.prevent="lookup">
      <label for="user-code">Code</label>
      <input
        id="user-code"
        v-model="code"
        placeholder="XXXX-XXXX"
        autocomplete="off"
        data-test="code-input"
      />
      <button type="submit" :disabled="busy || !code.trim()" data-test="code-lookup">
        Continue
      </button>
    </form>
  </div>

  <div v-if="pending" class="panel" data-test="pending">
    <h2>Approve this device?</h2>
    <p>
      <strong>{{ pending.client_name }}</strong>
      <span v-if="pending.device_name"> — {{ pending.device_name }}</span>
    </p>
    <p class="muted">
      Code {{ pending.user_code }} · requesting: {{ pending.scopes }}
    </p>
    <label for="device-name">Call this device</label>
    <input id="device-name" v-model="name" data-test="device-name" />
    <div class="row">
      <button :disabled="busy" data-test="approve" @click="decide(true)">Approve</button>
      <button class="danger" :disabled="busy" data-test="deny" @click="decide(false)">
        Deny
      </button>
    </div>
  </div>
</template>
