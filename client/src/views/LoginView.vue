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
  <div class="panel" style="max-width: 26rem; margin: 4rem auto">
    <h1>Log in</h1>
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
