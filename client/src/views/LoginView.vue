<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await auth.login(username.value, password.value);
    router.push(route.query.redirect || { name: 'modules' });
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <!-- The only page without the top bar, so it carries the mark itself. -->
  <div class="panel login-panel">
    <img class="login-mark" src="/logo-white.svg" alt="Aleph Void" />
    <h1>Eurorack Assistant</h1>
    <p class="muted">Log in to your rack.</p>
    <form @submit.prevent="submit">
      <label for="username">Username</label>
      <input id="username" v-model="username" autocomplete="username" required />
      <label for="password">Password</label>
      <input
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
      />
      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <button type="submit" :disabled="busy">Log in</button>
    </form>
  </div>
</template>
