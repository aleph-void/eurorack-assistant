<script setup>
// One performance: the video, what its author said about it, the modules it
// was played on, the patch if they chose to show it, and the conversation
// under it. Readable by every account, and by anyone at all when the author
// opened it to the world — so this is the one page in the app a visitor
// without a session may land on, and it has to make sense to them: the video
// plays, the words read, and where an account could do more (comment, open
// a module's page) the page says so instead of failing.
import { computed, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import { useAuthStore } from '../stores/auth.js';
import { youtubeEmbedUrl } from '../youtubeEmbed.js';
import PatchDiagram from '../components/PatchDiagram.vue';
import PerformanceForm from '../components/performances/PerformanceForm.vue';

const props = defineProps({
  id: { type: [String, Number], required: true },
});

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const performance = ref(null);
const loading = ref(true);
const error = ref('');
// A private performance reached without a session: not an error, an invitation.
const needsLogin = ref(false);
const editing = ref(false);
const saving = ref(false);

// The patch is read only when its section is opened: it is the same payload
// a patch page draws, and most viewers came for the video.
const patch = shallowRef(null);
const patchOpen = ref(false);
const patchLoading = ref(false);
const patchError = ref('');

const comment = ref('');
const commenting = ref(false);
const commentError = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  needsLogin.value = false;
  try {
    performance.value = await api.get(`/api/performances/${props.id}`, { quiet: true });
  } catch (e) {
    if (e.status === 401) needsLogin.value = true;
    else if (e.status === 404) error.value = 'There is no such performance. It may have been deleted.';
    else error.value = e.message;
    performance.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.id,
  () => {
    patch.value = null;
    patchOpen.value = false;
    editing.value = false;
    load();
  },
  { immediate: true }
);

const embedUrl = computed(() => youtubeEmbedUrl(performance.value?.video_id));
const loginTo = computed(() => ({ name: 'login', query: { redirect: route.fullPath } }));
const when = (value) => (value ? new Date(value).toLocaleString() : '');

async function openPatch() {
  patchOpen.value = !patchOpen.value;
  if (!patchOpen.value || patch.value || patchLoading.value) return;
  patchLoading.value = true;
  patchError.value = '';
  try {
    patch.value = await api.get(`/api/performances/${props.id}/patch`);
  } catch (e) {
    patchError.value = e.message;
  } finally {
    patchLoading.value = false;
  }
}

// The label under each panel in the diagram, as the patch's owner sees it.
const patchLabel = (pm) =>
  `${pm.manufacturer} ${pm.module_name}${pm.instance > 1 ? ` #${pm.instance}` : ''}` +
  (pm.label ? ` — ${pm.label}` : '');

async function save(payload) {
  saving.value = true;
  error.value = '';
  try {
    performance.value = await api.put(`/api/performances/${props.id}`, payload);
    editing.value = false;
    // The patch shown may have changed; it is read again when asked for.
    patch.value = null;
    patchOpen.value = false;
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const ok = await dialog.confirm({
    title: 'Delete performance',
    message: `Delete '${performance.value.title}'? The video stays on YouTube; this page and every comment under it go.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/api/performances/${props.id}`);
    router.push('/performances');
  } catch (e) {
    error.value = e.message;
  }
}

async function postComment() {
  const body = comment.value.trim();
  if (!body) return;
  commenting.value = true;
  commentError.value = '';
  try {
    const created = await api.post(`/api/performances/${props.id}/comments`, { body });
    performance.value = {
      ...performance.value,
      comments: [...performance.value.comments, created],
      comment_count: performance.value.comment_count + 1,
    };
    comment.value = '';
  } catch (e) {
    commentError.value = e.message;
  } finally {
    commenting.value = false;
  }
}

async function removeComment(c) {
  const ok = await dialog.confirm({
    title: 'Remove comment',
    message: c.mine ? 'Remove your comment?' : `Remove ${c.username}'s comment?`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  commentError.value = '';
  try {
    await api.delete(`/api/performances/${props.id}/comments/${c.id}`);
    performance.value = {
      ...performance.value,
      comments: performance.value.comments.filter((x) => x.id !== c.id),
      comment_count: Math.max(0, performance.value.comment_count - 1),
    };
  } catch (e) {
    commentError.value = e.message;
  }
}
</script>

<template>
  <p v-if="loading" class="muted">Loading…</p>

  <!-- A private performance, seen from outside. -->
  <div v-else-if="needsLogin" class="panel" data-test="needs-login">
    <h1>A performance</h1>
    <p>
      This performance is shared with the people who use this app.
      <RouterLink :to="loginTo" data-test="login-link">Log in</RouterLink> to watch it.
    </p>
  </div>

  <p v-else-if="error && !performance" class="error" data-test="error">{{ error }}</p>

  <template v-else-if="performance">
    <h1 data-test="title">{{ performance.title }}</h1>
    <p class="muted" data-test="byline">
      Shared by <strong>{{ performance.owner_username }}</strong> · {{ when(performance.created_at) }}
      <span v-if="performance.public" class="badge pending" data-test="public-badge">public</span>
    </p>
    <p v-if="error" class="error" data-test="error">{{ error }}</p>

    <div class="panel">
      <div class="video-frame">
        <iframe
          v-if="embedUrl"
          :src="embedUrl"
          :title="performance.title"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen
          data-test="video"
        ></iframe>
      </div>
      <p class="muted">
        <a :href="performance.url" target="_blank" rel="noopener noreferrer" data-test="watch-link">
          Watch on YouTube
        </a>
      </p>
      <p v-if="performance.description" class="description" data-test="description">
        {{ performance.description }}
      </p>
    </div>

    <div class="panel" data-test="modules-section">
      <h2>Modules used</h2>
      <ul v-if="performance.modules.length" data-test="module-list">
        <li v-for="m in performance.modules" :key="m.id" :data-test="`module-${m.id}`">
          <!-- A module you have is a page you can open; one you do not is a name. -->
          <RouterLink v-if="m.yours" :to="`/modules/${m.id}`">
            {{ m.manufacturer }} {{ m.name }}
          </RouterLink>
          <template v-else>{{ m.manufacturer }} {{ m.name }}</template>
          <span v-if="m.hp" class="muted"> · {{ m.hp }} HP</span>
        </li>
      </ul>
      <p v-else class="muted" data-test="no-modules">
        {{ performance.owner_username }} did not list the modules used.
      </p>
    </div>

    <div class="panel" data-test="patch-section">
      <h2>The patch</h2>
      <template v-if="performance.patch?.live">
        <p class="muted">
          {{ performance.owner_username }} is showing the patch '{{ performance.patch.name }}' —
          every cable and setting, as a shared patch reads.
        </p>
        <button type="button" class="secondary" data-test="toggle-patch" @click="openPatch">
          {{ patchOpen ? 'Hide the patch' : 'Show the patch' }}
        </button>
        <template v-if="patchOpen">
          <p v-if="patchLoading" class="muted">Loading the patch…</p>
          <p v-else-if="patchError" class="error" data-test="patch-error">{{ patchError }}</p>
          <div v-else-if="patch" data-test="patch">
            <p v-if="patch.description" style="white-space: pre-wrap">{{ patch.description }}</p>
            <PatchDiagram
              :modules="patch.modules || []"
              :cables="patch.cables || []"
              :switches="patch.switches || []"
              :mults="patch.mults || []"
              :label-for="patchLabel"
            />
            <h3>Cables</h3>
            <ul v-if="patch.cables?.length" data-test="patch-cables">
              <li v-for="c in patch.cables" :key="c.id">
                {{ c.from_component_name }} → {{ c.to_component_name }}
                <span v-if="c.note" class="muted">— {{ c.note }}</span>
              </li>
            </ul>
            <p v-else class="muted">No cables in this patch.</p>
            <template v-if="patch.settings?.length">
              <h3>Settings</h3>
              <ul data-test="patch-settings">
                <li v-for="s in patch.settings" :key="s.id">{{ s.component_name }}: {{ s.value }}</li>
              </ul>
            </template>
          </div>
        </template>
      </template>
      <p v-else-if="performance.patch" class="muted" data-test="patch-gone">
        This was played on the patch '{{ performance.patch.name }}', which has since been deleted.
      </p>
      <p v-else class="muted" data-test="no-patch">
        {{ performance.owner_username }} is not showing the patch.
      </p>
    </div>

    <div class="panel" data-test="comments-section">
      <h2>
        Comments
        <span v-if="performance.comments.length" class="badge">{{ performance.comments.length }}</span>
      </h2>
      <p v-if="commentError" class="error" data-test="comment-error">{{ commentError }}</p>
      <ul v-if="performance.comments.length" class="comments" data-test="comment-list">
        <li v-for="c in performance.comments" :key="c.id" class="comment" :data-test="`comment-${c.id}`">
          <p class="muted comment-head">
            <strong>{{ c.username }}</strong> · {{ when(c.created_at) }}
            <button
              v-if="c.can_delete"
              type="button"
              class="danger small"
              :data-test="`remove-comment-${c.id}`"
              @click="removeComment(c)"
            >
              Remove
            </button>
          </p>
          <p class="comment-body">{{ c.body }}</p>
        </li>
      </ul>
      <p v-else class="muted" data-test="no-comments">Nobody has commented yet.</p>

      <form v-if="auth.isLoggedIn" data-test="comment-form" @submit.prevent="postComment">
        <label for="performance-comment">Leave a comment</label>
        <textarea
          id="performance-comment"
          v-model="comment"
          rows="3"
          maxlength="5000"
          data-test="comment-body"
        ></textarea>
        <button type="submit" :disabled="commenting || !comment.trim()" data-test="comment-submit">
          Post
        </button>
      </form>
      <p v-else class="muted" data-test="comment-login">
        <RouterLink :to="loginTo">Log in</RouterLink> to leave a comment.
      </p>
    </div>

    <!-- The author's controls. -->
    <div v-if="performance.mine || performance.can_delete" class="panel" data-test="author-section">
      <h2>{{ performance.mine ? 'Your performance' : 'Moderation' }}</h2>
      <template v-if="performance.mine">
        <button v-if="!editing" type="button" data-test="edit" @click="editing = true">Edit</button>
        <PerformanceForm
          v-else
          :key="performance.updated_at"
          :initial="performance"
          submit-label="Save"
          :busy="saving"
          @submit="save"
          @cancel="editing = false"
        />
      </template>
      <p class="muted" style="margin-top: 0.8rem">
        <button type="button" class="danger" data-test="delete" @click="remove">Delete performance</button>
      </p>
    </div>
  </template>
</template>

<style scoped>
/* The player keeps the video's own proportions whatever width the page has:
   a phone draws it edge to edge, a desk draws it as wide as the panel. */
.video-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
}
.video-frame iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}
.description {
  white-space: pre-wrap;
}
.comments {
  list-style: none;
  padding: 0;
  margin: 0 0 1rem;
}
.comment {
  border-top: 1px solid var(--border);
  padding: 0.6rem 0;
}
.comment-head {
  margin: 0 0 0.2rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.comment-head button {
  margin: 0;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
}
.comment-body {
  margin: 0;
  white-space: pre-wrap;
}
</style>
