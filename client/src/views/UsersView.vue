<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const users = ref([]);
const username = ref('');
const email = ref('');
const password = ref('');
const error = ref('');
const created = ref(null);
const resetResult = ref(null);
const busy = ref(false);
const usage = ref(null);
// The active-user ceiling and the count against it (GET /api/users/registration).
const registration = ref(null);
const registrationClosed = computed(() => registration.value?.limit > 0 && !registration.value.open);

const periodLabels = { day: 'last 24 hours', week: 'last 7 days', month: 'last 30 days' };

// Spending per user, keyed by id, for the window the admin configured.
const spending = computed(() => new Map((usage.value?.users || []).map((u) => [u.id, u])));

const tokens = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

async function load() {
  try {
    users.value = await api.get('/api/users');
    usage.value = await api.get('/api/usage');
    registration.value = await api.get('/api/users/registration');
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
    const body = { username: username.value, email: email.value.trim() };
    if (password.value) body.password = password.value;
    created.value = await api.post('/api/users', body);
    username.value = '';
    email.value = '';
    password.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

// A user's address, put right by the admin: the row's own small form, one
// open at a time. Whatever was confirmed was the old address, so the server
// starts the confirmation over and says whether the mail went.
const editingEmail = ref(null);
const emailDraft = ref('');
const emailResult = ref(null);

function editEmail(user) {
  editingEmail.value = user.id;
  emailDraft.value = user.email;
  emailResult.value = null;
}

async function saveEmail(user) {
  error.value = '';
  try {
    const updated = await api.put(`/api/users/${user.id}/email`, { email: emailDraft.value.trim() });
    emailResult.value = { username: updated.username, email: updated.email, ...updated.verification };
    editingEmail.value = null;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// Shutting an account logs it out everywhere; opening one also forgets the
// failed logins that may have shut it.
async function setLocked(user, locked) {
  if (locked) {
    const ok = await dialog.confirm({
      title: 'Lock account',
      message: `Lock ${user.username}'s account? They are logged out everywhere and cannot log in until it is unlocked.`,
      confirmLabel: 'Lock account',
      danger: true,
    });
    if (!ok) return;
  }
  error.value = '';
  try {
    await api.put(`/api/users/${user.id}/lock`, { locked });
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

const lockLabel = (user) =>
  user.locked_reason === 'failed_logins' ? 'locked after failed logins' : 'locked by admin';

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
    message:
      `Delete user ${user.username}? Their racks, questions and notes go with ` +
      'them; the module records themselves stay on the server.',
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

// ---- handing a system to another user ----
// The admin picks whose system, which one, and who gets it; the server moves
// the racks, the patches made from it and everything written about them
// (services/systemTransfer.js is the list) and answers with what went.
const transferOwner = ref('');
const transferSystems = ref([]);
const transferSystemId = ref('');
const transferTo = ref('');
const transferResult = ref(null);
const transferError = ref('');
const transferBusy = ref(false);

const recipients = computed(() =>
  users.value.filter((user) => String(user.id) !== String(transferOwner.value))
);
const transferSystem = computed(() =>
  transferSystems.value.find((system) => String(system.id) === String(transferSystemId.value)) || null
);
const usernameOf = (id) => users.value.find((user) => String(user.id) === String(id))?.username || '';

async function loadTransferSystems() {
  transferSystemId.value = '';
  transferSystems.value = [];
  transferResult.value = null;
  transferError.value = '';
  if (transferOwner.value === '') return;
  try {
    transferSystems.value = await api.get(`/api/users/${transferOwner.value}/systems`);
  } catch (e) {
    transferError.value = e.message;
  }
}

const movedLabels = [
  ['racks', 'racks'],
  ['modules', 'modules'],
  ['patches', 'patches'],
  ['compositions', 'compositions'],
  ['notes', 'notes'],
  ['questions', 'questions'],
  ['captures', 'scope captures'],
  ['clips', 'scope clips'],
  ['recordings', 'recordings'],
  ['links', 'links'],
  ['videos', 'videos'],
  ['documents', 'uploaded documents'],
  ['shares', 'shares'],
  ['jobs', 'jobs'],
];
const movedSummary = computed(() =>
  movedLabels
    .filter(([key]) => transferResult.value?.moved?.[key] > 0)
    .map(([key, label]) => `${transferResult.value.moved[key]} ${label}`)
);

async function transfer() {
  const system = transferSystem.value;
  if (!system || transferTo.value === '') return;
  const ok = await dialog.confirm({
    title: 'Transfer system',
    message:
      `Hand ${system.name} from ${usernameOf(transferOwner.value)} to ${usernameOf(transferTo.value)}? ` +
      `Its ${system.rack_count} rack(s), ${system.module_count} module(s) and ${system.patch_count} ` +
      'patch(es) go with it, along with the notes, questions and attachments about them. ' +
      `${usernameOf(transferOwner.value)} keeps nothing of it.`,
    confirmLabel: 'Transfer',
    danger: true,
  });
  if (!ok) return;
  transferError.value = '';
  transferResult.value = null;
  transferBusy.value = true;
  try {
    const result = await api.post(`/api/systems/${system.id}/transfer`, {
      user_id: Number(transferTo.value),
    });
    await loadTransferSystems();
    transferResult.value = result;
  } catch (e) {
    transferError.value = e.message;
  } finally {
    transferBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <h1>Users</h1>

  <div class="panel">
    <h2>Create user</h2>
    <!-- At the ceiling there is nothing to fill in: the form goes, and the
         message stands where it was. -->
    <p v-if="registrationClosed" class="error" data-test="registration-closed">
      Registration is closed: {{ registration.active }} of {{ registration.limit }} active users
      (anyone who logged in within the last {{ registration.window_days }} days). Raise the
      maximum on the Configuration page to add more.
    </p>
    <template v-else>
      <p class="muted">New accounts are regular (non-admin) users.</p>
      <p v-if="registration?.limit > 0" class="muted" data-test="registration">
        {{ registration.active }} of {{ registration.limit }} active users (anyone who logged in
        within the last {{ registration.window_days }} days); registration closes at the maximum,
        set on the Configuration page.
      </p>
      <form @submit.prevent="createUser">
        <div class="row">
          <div>
            <label for="new-username">Username</label>
            <input id="new-username" v-model="username" data-test="username" required />
          </div>
          <div>
            <label for="new-email">Email</label>
            <input
              id="new-email"
              v-model="email"
              data-test="email"
              type="email"
              autocomplete="off"
              placeholder="name@example.com"
              required
            />
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
    </template>
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
      <p v-if="created.verification" class="muted" style="margin: 0.4rem 0 0" data-test="created-verification">
        <template v-if="created.verification.sent">
          A confirmation link was mailed to {{ created.email }}.
        </template>
        <template v-else>
          The confirmation mail did not go: {{ created.verification.problem }}
        </template>
      </p>
    </div>
  </div>

  <div class="panel">
    <h2>Transfer a system</h2>
    <p class="muted">
      Hand one user's system to another, whole: its racks and their modules, the patches made
      from it, and the notes, questions, recordings, captures, documents and links about any
      of those. Nothing is copied — the records change hands, and a name the new owner already
      uses takes the next free one.
    </p>
    <div class="row">
      <div>
        <label for="transfer-owner">From</label>
        <select
          id="transfer-owner"
          v-model="transferOwner"
          data-test="transfer-owner"
          @change="loadTransferSystems"
        >
          <option value="">Pick a user</option>
          <option v-for="user in users" :key="user.id" :value="String(user.id)">
            {{ user.username }}
          </option>
        </select>
      </div>
      <div>
        <label for="transfer-system">System</label>
        <select
          id="transfer-system"
          v-model="transferSystemId"
          data-test="transfer-system"
          :disabled="transferOwner === ''"
        >
          <option value="">
            {{
              transferOwner === ''
                ? 'Pick a user first'
                : transferSystems.length
                  ? 'Pick a system'
                  : 'No systems'
            }}
          </option>
          <option v-for="system in transferSystems" :key="system.id" :value="String(system.id)">
            {{ system.name }} ({{ system.rack_count }} racks, {{ system.module_count }} modules,
            {{ system.patch_count }} patches)
          </option>
        </select>
      </div>
      <div>
        <label for="transfer-to">To</label>
        <select id="transfer-to" v-model="transferTo" data-test="transfer-to">
          <option value="">Pick a user</option>
          <option v-for="user in recipients" :key="user.id" :value="String(user.id)">
            {{ user.username }}
          </option>
        </select>
      </div>
      <div class="shrink">
        <button
          type="button"
          class="danger"
          data-test="transfer"
          :disabled="transferBusy || !transferSystem || transferTo === ''"
          @click="transfer"
        >
          Transfer
        </button>
      </div>
    </div>
    <p v-if="transferError" class="error" data-test="transfer-error">{{ transferError }}</p>
    <div v-if="transferResult" class="password-reveal" data-test="transfer-result">
      <p style="margin: 0 0 0.4rem">
        <strong>{{ transferResult.system.name }}</strong> now belongs to
        <strong>{{ transferResult.to.username }}</strong
        ><template v-if="transferResult.from"> (it was {{ transferResult.from.username }}'s)</template>.
      </p>
      <p v-if="movedSummary.length" style="margin: 0" data-test="transfer-moved">
        Moved: {{ movedSummary.join(', ') }}.
      </p>
      <p v-if="transferResult.kept_modules > 0" class="muted" style="margin: 0.4rem 0 0">
        {{ transferResult.kept_modules }} module(s) also stand in a rack the previous owner keeps,
        so their notes and questions on those stayed.
      </p>
      <p v-if="transferResult.renamed?.length" class="muted" style="margin: 0.4rem 0 0" data-test="transfer-renamed">
        Renamed to stay unique:
        <template v-for="(entry, i) in transferResult.renamed" :key="`${entry.kind}-${entry.id}`">
          <template v-if="i > 0">, </template>
          {{ entry.kind }} '{{ entry.from }}' → '{{ entry.to }}'
        </template>
        .
      </p>
    </div>
  </div>

  <div class="panel">
    <p v-if="emailResult" class="muted" data-test="email-result">
      Address for <strong>{{ emailResult.username }}</strong> changed to
      <strong>{{ emailResult.email }}</strong>.
      <template v-if="emailResult.sent">A confirmation link was mailed to it.</template>
      <template v-else>The confirmation mail did not go: {{ emailResult.problem }}</template>
    </p>
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
            <th>Email</th>
            <th>Role</th>
            <th>Created</th>
            <th>Last login</th>
            <th>Spent</th>
            <th>Budget</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td data-label="Username">{{ user.username }}</td>
            <td data-label="Email" :data-test="`email-${user.id}`">
              <div v-if="editingEmail === user.id" class="actions nowrap">
                <input
                  v-model="emailDraft"
                  type="email"
                  :data-test="`email-input-${user.id}`"
                  style="width: 14rem"
                  @keyup.enter="saveEmail(user)"
                  @keyup.esc="editingEmail = null"
                />
                <button :data-test="`save-email-${user.id}`" @click="saveEmail(user)">Save</button>
                <button @click="editingEmail = null">Cancel</button>
              </div>
              <template v-else>
                {{ user.email }}
                <span
                  class="badge"
                  :class="user.email_verified_at ? 'found' : 'pending'"
                  :data-test="`email-state-${user.id}`"
                >
                  {{ user.email_verified_at ? 'confirmed' : 'unconfirmed' }}
                </span>
                <button
                  v-if="user.id !== auth.user?.id"
                  class="small"
                  :data-test="`edit-email-${user.id}`"
                  @click="editEmail(user)"
                >
                  Change
                </button>
              </template>
            </td>
            <td data-label="Role">
              <span class="badge" :class="user.is_admin ? 'found' : ''">
                {{ user.is_admin ? 'admin' : 'user' }}
              </span>
              <span v-if="user.locked_at" class="badge failed" :data-test="`locked-${user.id}`">
                {{ lockLabel(user) }}
              </span>
              <span v-if="user.active === false" class="badge" :data-test="`inactive-${user.id}`">
                inactive
              </span>
            </td>
            <td data-label="Created" class="muted">{{ new Date(user.created_at).toLocaleDateString() }}</td>
            <td data-label="Last login" class="muted" :data-test="`last-login-${user.id}`">
              {{ user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'never' }}
            </td>
            <td data-label="Spent" :data-test="`spent-${user.id}`">
              {{ tokens(spending.get(user.id)?.used ?? 0) }}
              <span
                v-if="spending.get(user.id)?.exhausted"
                class="badge failed"
                data-test="exhausted"
                >budget spent</span
              >
            </td>
            <td data-label="Budget">
              <template v-if="user.is_admin">
                <span class="muted">exempt</span>
              </template>
              <div v-else class="actions nowrap">
                <input
                  :value="budgetFor(user)"
                  :data-test="`budget-${user.id}`"
                  type="number"
                  min="0"
                  step="1000"
                  placeholder="default"
                  style="width: 8rem"
                  @input="budgets[user.id] = $event.target.value"
                  @keyup.enter="saveBudget(user)"
                />
                <button :data-test="`save-budget-${user.id}`" @click="saveBudget(user)">
                  Save
                </button>
              </div>
            </td>
            <td class="actions-cell">
              <div v-if="user.id !== auth.user?.id" class="actions nowrap">
                <button :data-test="`reset-${user.id}`" @click="resetPassword(user)">
                  Reset password
                </button>
                <button
                  v-if="user.locked_at"
                  :data-test="`unlock-${user.id}`"
                  @click="setLocked(user, false)"
                >
                  Unlock
                </button>
                <button v-else :data-test="`lock-${user.id}`" @click="setLocked(user, true)">
                  Lock
                </button>
                <button
                  class="danger"
                  :data-test="`delete-${user.id}`"
                  @click="removeUser(user)"
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
