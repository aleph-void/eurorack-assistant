<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { useJobsStore } from '../stores/jobs.js';

const jobs = useJobsStore();

const mode = ref('text');
const content = ref('');
const url = ref('');
// '' selects "create a new rack"; otherwise the id of an existing rack.
const NEW_RACK = '';
const racks = ref([]);
const rackChoice = ref(NEW_RACK);
const newRackName = ref('');
const error = ref('');
const queuedJobId = ref(null);
const busy = ref(false);

onMounted(async () => {
  try {
    racks.value = (await api.get('/api/racks')) || [];
  } catch {
    racks.value = [];
  }
  if (racks.value.length > 0) {
    const main = racks.value.find((r) => r.name.toLowerCase() === 'main rack');
    rackChoice.value = (main || racks.value[0]).id;
  }
});

const rack = computed(() =>
  rackChoice.value === NEW_RACK
    ? newRackName.value.trim()
    : racks.value.find((r) => r.id === rackChoice.value)?.name || ''
);

const jobFeed = computed(() => jobs.feed.filter((f) => f.jobId != null));

async function onFile(event) {
  const file = event.target.files?.[0];
  if (file) content.value = await file.text();
}

async function submit() {
  error.value = '';
  queuedJobId.value = null;
  busy.value = true;
  try {
    const body =
      mode.value === 'modulargrid'
        ? { type: 'modulargrid', url: url.value, rack: rack.value }
        : { type: mode.value, content: content.value, rack: rack.value };
    const res = await api.post('/api/imports', body);
    queuedJobId.value = res.job_id;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <h1>Import modules</h1>
  <div class="panel">
    <div class="row">
      <div>
        <label for="mode">Source</label>
        <select id="mode" v-model="mode" data-test="mode">
          <option value="text">Newline-delimited list</option>
          <option value="csv">CSV file</option>
          <option value="modulargrid">ModularGrid rack URL</option>
        </select>
      </div>
      <div>
        <label for="rack-select">Into rack</label>
        <select id="rack-select" v-model="rackChoice" data-test="rack-select">
          <option v-for="r in racks" :key="r.id" :value="r.id">{{ r.name }}</option>
          <option :value="NEW_RACK">+ Create a new rack…</option>
        </select>
      </div>
      <div v-if="rackChoice === NEW_RACK">
        <label for="rack">New rack name</label>
        <input id="rack" v-model="newRackName" data-test="rack" placeholder="main rack" />
      </div>
    </div>

    <form @submit.prevent="submit">
      <template v-if="mode === 'modulargrid'">
        <label for="url">Rack URL</label>
        <input
          id="url"
          v-model="url"
          data-test="url"
          placeholder="https://modulargrid.net/e/racks/view/2250471"
        />
      </template>
      <template v-else>
        <label for="file">Upload a file…</label>
        <input id="file" type="file" data-test="file" @change="onFile" />
        <label for="content">…or paste your module list</label>
        <textarea
          id="content"
          v-model="content"
          data-test="content"
          :placeholder="
            mode === 'csv'
              ? '&quot;manufacturer&quot;,&quot;module&quot;,&quot;quantity&quot;,&quot;hp&quot;'
              : 'Make Noise,Maths 20HP\nMutable Instruments Beads'
          "
        ></textarea>
        <p class="muted" data-test="hp-hint">
          Panel widths are optional. A CSV with a header row may carry an <code>hp</code> column,
          and a width written after a name ("Maths 20HP") is read off it. Anything you leave out is
          taken from the module's manual when it is analyzed.
        </p>
      </template>

      <p v-if="error" class="error" data-test="error">{{ error }}</p>
      <p v-if="queuedJobId" class="success" data-test="queued">
        Import queued as job #{{ queuedJobId }}. Manuals will be found and analyzed automatically —
        follow progress below or on the <RouterLink to="/jobs">Jobs</RouterLink> page.
      </p>
      <button type="submit" :disabled="busy" data-test="submit">Import</button>
    </form>
  </div>

  <div v-if="queuedJobId" class="panel">
    <h2>Live progress</h2>
    <div class="feed" data-test="feed">
      <div v-for="(line, i) in jobFeed" :key="i">
        <span class="muted">[job {{ line.jobId }} · {{ line.type }}]</span> {{ line.message }}
      </div>
      <div v-if="jobFeed.length === 0" class="muted">Waiting for the worker…</div>
    </div>
  </div>
</template>
