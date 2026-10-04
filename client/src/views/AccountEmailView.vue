<script setup>
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth.js';

// The address a password reset is sent to. It is as good as the password —
// whoever reads the mail picks the next one — so changing it asks for the
// current password, the way the password change does, and the new address
// counts for nothing until the link mailed to it is followed.

const PLACEHOLDER_DOMAIN = '@unset.invalid';

const auth = useAuthStore();

// An account from before addresses were kept carries a placeholder nobody
// can keep; the field starts empty so the person types theirs, not edits it.
const isPlaceholder = (email) => typeof email === 'string' && email.endsWith(PLACEHOLDER_DOMAIN);
const shown = (email) => (isPlaceholder(email) ? '' : email || '');

const email = ref(shown(auth.user?.email));
const currentPassword = ref('');
const error = ref('');
const result = ref(null);
const resent = ref(null);
const busy = ref(false);

// The store loads the user after this page may already be on screen.
watch(
  () => auth.user?.email,
  (value) => {
    if (!result.value && email.value === '') email.value = shown(value);
  }
);

const needsAddress = computed(() => isPlaceholder(auth.user?.email));
const confirmed = computed(() => Boolean(auth.user?.email_verified_at));

async function submit() {
  error.value = '';
  result.value = null;
  resent.value = null;
  busy.value = true;
  try {
    const { user, verification } = await auth.updateEmail(email.value.trim(), currentPassword.value);
    email.value = user.email;
    currentPassword.value = '';
    result.value = verification;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function resend() {
  error.value = '';
  resent.value = null;
  busy.value = true;
  try {
    resent.value = await auth.resendVerification();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="panel" style="max-width: 26rem; margin: 4rem auto">
    <h1>Email address</h1>
    <p class="muted">
      Where a password reset is sent. An address counts once the link mailed to it has been
      opened.
    </p>

    <p v-if="needsAddress" class="error" data-test="needs-address">
      Your account has no email address yet. Add one below.
    </p>
    <p v-else-if="confirmed" class="muted" data-test="confirmed">
      <span class="badge found">confirmed</span> {{ auth.user.email }}
    </p>
    <p v-else-if="auth.user" class="muted" data-test="unconfirmed">
      <span class="badge pending">unconfirmed</span> {{ auth.user.email }} — open the link in the
      mail we sent, or
      <button type="button" class="small" :disabled="busy" data-test="resend" @click="resend">
        send it again
      </button>
    </p>
    <p v-if="resent" class="muted" data-test="resent">
      {{ resent.sent ? 'Sent. Check your inbox.' : resent.problem }}
    </p>

    <form @submit.prevent="submit">
      <label for="account-email">Email</label>
      <input
        id="account-email"
        v-model="email"
        type="email"
        autocomplete="email"
        placeholder="name@example.com"
        data-test="email"
        required
      />
      <label for="current-password">Current password</label>
      <input
        id="current-password"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        data-test="current-password"
        required
      />
      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <p v-else-if="result" class="muted" data-test="saved">
        <template v-if="result.sent">
          Saved. A confirmation link was mailed to {{ auth.user.email }} — open it to finish.
        </template>
        <template v-else-if="result.problem">Saved, but {{ result.problem }}</template>
        <template v-else>Saved.</template>
      </p>
      <button type="submit" :disabled="busy">Save</button>
    </form>
    <p class="muted" style="margin-top: 1rem">
      <RouterLink to="/account/password">Change password</RouterLink>
    </p>
  </div>
</template>
