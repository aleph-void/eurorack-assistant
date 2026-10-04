<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

// The SMTP account every mail the app sends goes out through, and the public
// address the links in those mails point back to. The password is the one
// field the server never sends back: the box is blank, the label says whether
// one is kept, and leaving it blank keeps it.

const config = ref(null);
const host = ref('');
const port = ref(587);
const secure = ref(false);
const user = ref('');
const password = ref('');
const from = ref('');
const publicUrl = ref('');
const error = ref('');
const saved = ref(false);
const tested = ref(null);
const busy = ref(false);

function take(c) {
  config.value = c;
  host.value = c.mail_host || '';
  port.value = Number(c.mail_port) || 587;
  secure.value = Boolean(c.mail_secure);
  user.value = c.mail_user || '';
  from.value = c.mail_from || '';
  publicUrl.value = c.public_url || '';
  password.value = '';
}

onMounted(async () => {
  try {
    take(await api.get('/api/config/mail'));
  } catch (e) {
    error.value = e.message;
  }
});

async function save() {
  error.value = '';
  saved.value = false;
  tested.value = null;
  busy.value = true;
  try {
    const body = {
      mail_host: host.value,
      mail_port: port.value,
      mail_secure: secure.value,
      mail_user: user.value,
      mail_from: from.value,
      public_url: publicUrl.value,
    };
    if (password.value !== '') body.mail_password = password.value;
    take(await api.put('/api/config/mail', body));
    saved.value = true;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function clearPassword() {
  error.value = '';
  busy.value = true;
  try {
    take(await api.put('/api/config/mail', { mail_password: '' }));
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function sendTest() {
  error.value = '';
  tested.value = null;
  busy.value = true;
  try {
    tested.value = await api.post('/api/config/mail/test');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <h1>Mail server</h1>
  <div class="panel">
    <p class="muted">
      Every mail the app sends — a confirmation of an address, a password reset — goes out
      through this SMTP account, and every link in one points back at the public address
      below.
    </p>
    <p v-if="config?.problem" class="error" data-test="problem">
      Nothing can be sent yet: {{ config.problem }}.
    </p>
    <form @submit.prevent="save">
      <div class="row">
        <div>
          <label for="mail-host">SMTP host</label>
          <input id="mail-host" v-model="host" data-test="host" placeholder="smtp.example.com" />
        </div>
        <div class="shrink">
          <label for="mail-port">Port</label>
          <input
            id="mail-port"
            v-model.number="port"
            data-test="port"
            type="number"
            min="1"
            max="65535"
            style="width: 6rem"
          />
        </div>
      </div>
      <label class="check">
        <input v-model="secure" type="checkbox" data-test="secure" />
        Encrypted from the first byte (SMTPS, usually port 465). Off means STARTTLS when the
        server offers it.
      </label>
      <div class="row">
        <div>
          <label for="mail-user">Username</label>
          <input id="mail-user" v-model="user" data-test="user" autocomplete="off" />
        </div>
        <div>
          <label for="mail-password">
            Password
            <span v-if="config?.mail_password_set" class="muted" data-test="password-set">
              (one is kept — blank keeps it)
            </span>
          </label>
          <input
            id="mail-password"
            v-model="password"
            data-test="password"
            type="password"
            autocomplete="new-password"
          />
          <button
            v-if="config?.mail_password_set"
            type="button"
            class="small"
            data-test="clear-password"
            :disabled="busy"
            @click="clearPassword"
          >
            Remove the kept password
          </button>
        </div>
      </div>
      <label for="mail-from">From address</label>
      <input id="mail-from" v-model="from" data-test="from" type="email" placeholder="rack@example.com" />
      <label for="public-url">Public address of this app</label>
      <input
        id="public-url"
        v-model="publicUrl"
        data-test="public-url"
        type="url"
        placeholder="https://rack.example.com"
      />
      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <p v-if="saved" class="success" data-test="saved">Mail settings saved.</p>
      <p v-if="tested" class="success" data-test="tested">A test mail went to {{ tested.to }}.</p>
      <div class="actions">
        <button type="submit" :disabled="busy" data-test="save">Save</button>
        <button type="button" :disabled="busy || !!config?.problem" data-test="send-test" @click="sendTest">
          Send a test mail to me
        </button>
      </div>
    </form>
  </div>
</template>
