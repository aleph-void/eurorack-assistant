<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const users = ref([]);
const username = ref('');
const password = ref('');
const error = ref('');
const created = ref(null);
const resetResult = ref(null);
const busy = ref(false);

async function load() {
  try {
    users.value = await api.get('/api/users');
  } catch (e) {
    error.value = e.message;
  }
}

async function createUser() {
  error.value = '';
  created.value = null;
  busy.value = true;
  try {
    const body = { username: username.value };
    if (password.value) body.password = password.value;
    created.value = await api.post('/api/users', body);
    username.value = '';
    password.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function resetPassword(user) {
  if (
    !confirm(
      `Reset the password for ${user.username}? They are logged out everywhere and must set a new password at their next login.`
    )
  ) {
    return;
  }
  error.value = '';
  resetResult.value = null;
  try {
    resetResult.value = await api.post(`/api/users/${user.id}/password`);
  } catch (e) {
    error.value = e.message;
  }
}

async function removeUser(user) {
  if (!confirm(`Delete user ${user.username}? Their modules and questions are removed too.`)) {
    return;
  }
  error.value = '';
  try {
    await api.delete(`/api/users/${user.id}`);
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <h1>Users</h1>

  <div class="panel">
    <h2>Create user</h2>
    <p class="muted">New accounts are regular (non-admin) users.</p>
    <form @submit.prevent="createUser">
      <div class="row">
        <div>
          <label for="new-username">Username</label>
          <input id="new-username" v-model="username" data-test="username" required />
        </div>
        <div>
          <label for="new-password">Password (leave blank to generate)</label>
          <input id="new-password" v-model="password" data-test="password" type="text" />
        </div>
        <div class="shrink">
          <button type="submit" :disabled="busy" data-test="create">Create</button>
        </div>
      </div>
    </form>
    <p v-if="error" class="error" data-test="error">{{ error }}</p>
    <div v-if="created" class="password-reveal" data-test="created">
      <p style="margin: 0 0 0.4rem">
        User <strong>{{ created.username }}</strong> created.
      </p>
      <p v-if="created.generated_password" style="margin: 0">
        Generated password: <strong data-test="generated-password">{{ created.generated_password }}</strong
        ><br />
        <span class="muted">Share it now — it is not stored in cleartext and cannot be shown again.</span>
      </p>
    </div>
  </div>

  <div class="panel">
    <div v-if="resetResult" class="password-reveal" data-test="reset-result">
      <p style="margin: 0">
        Password for <strong>{{ resetResult.username }}</strong> reset. New password:
        <strong data-test="reset-password-value">{{ resetResult.generated_password }}</strong
        ><br />
        <span class="muted">
          Share it now — it is not stored in cleartext and cannot be shown again. They must
          pick their own password at their next login.
        </span>
      </p>
    </div>
    <table data-test="user-table">
      <thead>
        <tr>
          <th>Username</th>
          <th>Role</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users" :key="user.id">
          <td>{{ user.username }}</td>
          <td>
            <span class="badge" :class="user.is_admin ? 'found' : ''">
              {{ user.is_admin ? 'admin' : 'user' }}
            </span>
          </td>
          <td class="muted">{{ new Date(user.created_at).toLocaleDateString() }}</td>
          <td>
            <template v-if="user.id !== auth.user?.id">
              <button
                style="margin: 0 0.5rem 0 0"
                :data-test="`reset-${user.id}`"
                @click="resetPassword(user)"
              >
                Reset password
              </button>
              <button
                class="danger"
                style="margin: 0"
                :data-test="`delete-${user.id}`"
                @click="removeUser(user)"
              >
                Delete
              </button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
