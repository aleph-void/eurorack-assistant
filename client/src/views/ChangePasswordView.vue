<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const router = useRouter();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'New passwords do not match';
    return;
  }
  busy.value = true;
  try {
    await auth.changePassword(currentPassword.value, newPassword.value);
    router.push({ name: 'modules' });
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="panel" style="max-width: 26rem; margin: 4rem auto">
    <h1>Change password</h1>
    <p v-if="auth.mustChangePassword" class="muted" data-test="forced">
      You must set a new password before continuing.
    </p>
    <form @submit.prevent="submit">
      <label for="current-password">Current password</label>
      <input
        id="current-password"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        data-test="current-password"
        required
      />
      <label for="new-password">New password (at least 8 characters)</label>
      <input
        id="new-password"
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        minlength="8"
        data-test="new-password"
        required
      />
      <label for="confirm-password">Confirm new password</label>
      <input
        id="confirm-password"
        v-model="confirmPassword"
        type="password"
        autocomplete="new-password"
        data-test="confirm-password"
        required
      />
      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <button type="submit" :disabled="busy">Change password</button>
    </form>
  </div>
</template>
