<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { useAuthStore } from '../stores/auth.js';

// The page the confirmation mail links to. Public: the mail is read wherever
// it is read, which need not be a browser that is logged in. The token in the
// query is redeemed once, as the page opens.

const route = useRoute();
const auth = useAuthStore();
const email = ref('');
const error = ref('');
const busy = ref(true);

onMounted(async () => {
  try {
    const result = await api.post('/api/auth/verify-email', { token: route.query.token || '' }, { quiet: true });
    email.value = result.email;
    // If this is the browser that is logged in, the drawer's badge goes too.
    if (auth.user && auth.user.email === result.email) await auth.fetchMe();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
});
</script>

<template>
  <div class="panel login-panel">
    <h1>Email address</h1>
    <p v-if="busy" class="muted" data-test="busy">Confirming…</p>
    <template v-else-if="email">
      <p data-test="confirmed">
        <span class="badge found">confirmed</span> {{ email }} is now the address on your account.
      </p>
      <p class="muted">
        <RouterLink v-if="auth.isLoggedIn" to="/modules">Back to the app</RouterLink>
        <RouterLink v-else to="/login">Log in</RouterLink>
      </p>
    </template>
    <template v-else>
      <p class="error" data-test="error">{{ error }}</p>
      <p class="muted">
        Ask for a new link from
        <RouterLink to="/account/email">your account's email page</RouterLink>.
      </p>
    </template>
  </div>
</template>
