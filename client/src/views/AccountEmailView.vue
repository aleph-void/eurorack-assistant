<script setup>
import { ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth.js';

// The address a password reset is sent to. It is as good as the password —
// whoever reads the mail picks the next one — so changing it asks for the
// current password, the way the password change does. Blank takes it away.

const auth = useAuthStore();

const email = ref(auth.user?.email || '');
const currentPassword = ref('');
const error = ref('');
const saved = ref(false);
const busy = ref(false);

// The store loads the user after this page may already be on screen.
watch(
  () => auth.user?.email,
  (value) => {
    if (!saved.value && email.value === '') email.value = value || '';
  }
);

async function submit() {
  error.value = '';
  saved.value = false;
  busy.value = true;
  try {
    const user = await auth.updateEmail(email.value.trim(), currentPassword.value);
    email.value = user.email || '';
    currentPassword.value = '';
    saved.value = true;
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
      Where a password reset is sent. Leave it blank to keep no address on the account.
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
      <p v-else-if="saved" class="muted" data-test="saved">
        {{ auth.user?.email ? `Saved: ${auth.user.email}` : 'Address removed.' }}
      </p>
      <button type="submit" :disabled="busy">Save</button>
    </form>
    <p class="muted" style="margin-top: 1rem">
      <RouterLink to="/account/password">Change password</RouterLink>
    </p>
  </div>
</template>
