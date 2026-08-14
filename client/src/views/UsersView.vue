<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const users = ref([]);
const username = ref('');
const password = ref('');
const error = ref('');
const created = ref(null);
const resetResult = ref(null);
const busy = ref(false);
const usage = ref(null);

const periodLabels = { day: 'last 24 hours', week: 'last 7 days', month: 'last 30 days' };

// Spending per user, keyed by id, for the window the admin configured.
const spending = computed(() => new Map((usage.value?.users || []).map((u) => [u.id, u])));

const tokens = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

async function load() {
  try {
    users.value = await api.get('/api/users');
    usage.value = await api.get('/api/usage');
  } catch (e) {
    error.value = e.message;
  }
}

// What each row's budget box currently says, before it is saved. Blank hands
// the user back the configured default; 0 lifts their ceiling.
const budgets = ref({});

function budgetFor(user) {
  if (budgets.value[user.id] !== undefined) return budgets.value[user.id];
  return user.token_budget === null ? '' : String(user.token_budget);
}

async function saveBudget(user) {
  const typed = String(budgetFor(user)).trim();
  error.value = '';
  try {
    await api.put(`/api/users/${user.id}/budget`, {
      token_budget: typed === '' ? null : Number(typed),
    });
    delete budgets.value[user.id];
    await load();
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
  const ok = await dialog.confirm({
    title: 'Reset password',
    message: `Reset the password for ${user.username}? They are logged out everywhere and must set a new password at their next login.`,
    confirmLabel: 'Reset password',
  });
  if (!ok) return;
  error.value = '';
  resetResult.value = null;
  try {
    resetResult.value = await api.post(`/api/users/${user.id}/password`);
  } catch (e) {
    error.value = e.message;
  }
}

async function removeUser(user) {
  const ok = await dialog.confirm({
    title: 'Delete user',
    message: `Delete user ${user.username}? Their modules and questions are removed too.`,
    confirmLabel: 'Delete user',
    danger: true,
  });
  if (!ok) return;
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
          <label for="new-password">Password (min 8 chars, blank to generate)</label>
          <!-- minlength only applies when a value is present, so leaving the
               field blank still generates a password. -->
          <input
            id="new-password"
            v-model="password"
            data-test="password"
            type="text"
            minlength="8"
          />
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
    <p v-if="usage" class="muted" data-test="usage-window">
      Tokens spent in the {{ periodLabels[usage.period] || 'window' }}:
      <strong>{{ tokens(usage.total_tokens) }}</strong>
      <template v-if="usage.total_cost_usd > 0">
        (about ${{ usage.total_cost_usd.toFixed(2) }} at list price — nothing is billed per token
        on a subscription login)
      </template>
      . Default allowance:
      <strong>{{ usage.default_limit === 0 ? 'unlimited' : tokens(usage.default_limit) }}</strong
      >, set on the Configuration page.
    </p>
    <div class="table-wrap">
      <table data-test="user-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Created</th>
            <th>Spent</th>
            <th>Budget</th>
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
            <td :data-test="`spent-${user.id}`">
              {{ tokens(spending.get(user.id)?.used ?? 0) }}
              <span
                v-if="spending.get(user.id)?.exhausted"
                class="badge failed"
                data-test="exhausted"
                >budget spent</span
              >
            </td>
            <td>
              <template v-if="user.is_admin">
                <span class="muted">exempt</span>
              </template>
              <template v-else>
                <input
                  :value="budgetFor(user)"
                  :data-test="`budget-${user.id}`"
                  type="number"
                  min="0"
                  step="1000"
                  placeholder="default"
                  style="width: 8rem; margin: 0 0.4rem 0 0"
                  @input="budgets[user.id] = $event.target.value"
                  @keyup.enter="saveBudget(user)"
                />
                <button style="margin: 0" :data-test="`save-budget-${user.id}`" @click="saveBudget(user)">
                  Save
                </button>
              </template>
            </td>
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
  </div>
</template>
