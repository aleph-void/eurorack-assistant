<script setup>
// The module itself: the picture of the front plate and what the manual says
// the module is. Everything else about it — the components, the signal paths
// inside it, the documents, the videos, the notes — is a page of its own,
// reached from the nav drawer, so this page stays the one that is looked at
// rather than worked in.
import { computed, ref, toRef, watch } from 'vue';
import { api } from '../api.js';
import { dialog } from '../dialog.js';
import ModuleDetailHeader from '../components/moduledetail/ModuleDetailHeader.vue';
import PanelJacksSection from '../components/moduledetail/PanelJacksSection.vue';
import { useArranging } from '../components/moduledetail/useArranging.js';
import { useModuleRecord } from '../components/moduledetail/useModuleRecord.js';
import { fileToBase64 } from '../files.js';

const props = defineProps({ id: { type: String, required: true } });

const id = toRef(props, 'id');
const { module, error, rackModules, load } = useModuleRecord(id);
// The plate is on this page, so putting a marker right is on this page too:
// the jacks are listed beside the picture and each row is a toggle.
const arranging = useArranging(module, id, load);
const { panelError, panelStatus } = arranging;

// --- Component re-analysis with fresh retailer product pages ---
const reanalyzing = ref(false);
const reanalyzeNotice = ref('');
const reanalyzeError = ref('');
// The saved renders the re-analysis job would fetch. While any of them is
// already among the module's documents the button stays disabled (the server
// refuses on the same test): the point of the action is fetching them fresh.
const RETAILER_PAGE_RE = /_(Perfect_Circuit|Detroit_Modular|Midwest_Modular)_Product_Page\.pdf$/i;
const retailerPagesExist = computed(() =>
  (module.value?.manuals || []).some(
    (d) => d.user_id === null && RETAILER_PAGE_RE.test(d.original_name || '')
  )
);

// Shown as the button's hover tooltip rather than inline text.
const reanalyzeTitle = computed(() =>
  retailerPagesExist.value
    ? 'Retailer product pages already exist for this module (see Documents), so there is nothing new to fetch.'
    : "Fetches the module's product page from Perfect Circuit, Detroit Modular and Midwest Modular and re-analyzes the components with every page it finds."
);

const rebuildTitle =
  'Runs the manual analysis again with the saved documents marked for analysis in Documents. Nothing new is downloaded.';

async function reanalyzeComponents() {
  reanalyzeNotice.value = '';
  reanalyzeError.value = '';
  reanalyzing.value = true;
  try {
    await api.post(`/api/modules/${props.id}/reanalyze`);
    reanalyzeNotice.value =
      'Re-analysis queued: retailer product pages will be downloaded and the components analyzed again.';
    await load();
  } catch (e) {
    reanalyzeError.value = e.message;
  } finally {
    reanalyzing.value = false;
  }
}

// --- Analysis rebuild from the documents already on disk ---
const rebuilding = ref(false);
const rebuildNotice = ref('');
const rebuildError = ref('');

async function rebuildAnalysis() {
  rebuildNotice.value = '';
  rebuildError.value = '';
  rebuilding.value = true;
  try {
    await api.post(`/api/modules/${props.id}/analyze`);
    rebuildNotice.value =
      'Analysis queued: the manual and any saved vendor pages will be analyzed again.';
    await load();
  } catch (e) {
    rebuildError.value = e.message;
  } finally {
    rebuilding.value = false;
  }
}

// ---- front panel ----
// The app finds or draws a panel by itself, but the picture it ends up with
// can be the wrong module, or a diagram where a photograph exists. Supplying
// one replaces it for good: the panel job stops researching and instead
// locates this module's components on the picture supplied here.
const panelHp = ref('');
const panelHpDirty = ref(false);
const panelUrl = ref('');
const panelUploading = ref(false);

// The width beside panel import is an override, but the most useful starting
// value is what manual analysis (or a previous import) already established
// for the module. Do not wipe out an edit merely because an unrelated action
// refreshed the page.
watch(module, (loaded) => {
  if (loaded && !panelHpDirty.value) panelHp.value = loaded.hp == null ? '' : String(loaded.hp);
});

function panelHpField(body) {
  const hp = panelHp.value.trim();
  if (hp) body.hp = hp;
  return body;
}

async function uploadPanel(file) {
  panelError.value = '';
  panelUploading.value = true;
  try {
    const data_base64 = await fileToBase64(file);
    const body = panelHpField({ filename: file.name, data_base64 });
    await api.post(`/api/modules/${props.id}/panel`, body);
    panelHpDirty.value = false;
    await load();
  } catch (e) {
    panelError.value = e.message;
  } finally {
    panelUploading.value = false;
  }
}

async function downloadPanel() {
  const url = panelUrl.value.trim();
  if (!url) return;
  panelError.value = '';
  panelUploading.value = true;
  try {
    await api.post(`/api/modules/${props.id}/panel`, panelHpField({ url }));
    panelUrl.value = '';
    panelHpDirty.value = false;
    await load();
  } catch (e) {
    panelError.value = e.message;
  } finally {
    panelUploading.value = false;
  }
}

async function onPanelChosen(event) {
  const file = event.target.files?.[0];
  if (file) await uploadPanel(file);
  event.target.value = '';
}

// Cut the blank backdrop away from the panel picture. The server cuts the
// image file down to the front plate and re-bases every marker onto it, so
// the markers keep pointing at the same hardware and the picture on its own
// is the panel. It can only be done once — afterwards there is no backdrop
// left to find.
const trimmingPanel = ref(false);
async function trimPanel() {
  panelError.value = '';
  panelStatus.value = '';
  trimmingPanel.value = true;
  try {
    const { panel } = await api.post(`/api/modules/${props.id}/panel/trim`);
    if (panel && module.value) module.value = { ...module.value, panel };
    panelStatus.value = 'Cut the picture down to the front plate.';
  } catch (e) {
    panelError.value = e.message;
  } finally {
    trimmingPanel.value = false;
  }
}

// Markers with nothing behind them: drawn on the plate, in none of the
// lists, and unable to anchor a cable — a placement whose name never matched
// a component (most often the analysis echoing "PITCH A (knob)" whole). The
// server matches each to the component it names, and drops the ones that
// duplicate a component already placed.
const orphanMarkers = computed(
  () => (module.value?.panel?.components || []).filter((p) => !p.component_id).length
);
const relinking = ref(false);
async function relinkMarkers() {
  panelError.value = '';
  panelStatus.value = '';
  relinking.value = true;
  try {
    const result = await api.post(`/api/modules/${props.id}/panel/relink`);
    await load();
    panelStatus.value =
      result.linked || result.removed
        ? `Put ${result.linked} marker(s) back on their component` +
          (result.removed ? `, and removed ${result.removed} duplicate(s).` : '.')
        : 'None of these markers names a component of this module — rename or remove them by hand.';
  } catch (e) {
    panelError.value = e.message;
  } finally {
    relinking.value = false;
  }
}

async function removePanel() {
  const ok = await dialog.confirm({
    title: 'Remove panel image',
    message:
      'Discard the uploaded picture? The app will go back to finding or drawing a panel for this module.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  panelError.value = '';
  try {
    await api.delete(`/api/modules/${props.id}/panel`);
    await load();
  } catch (e) {
    panelError.value = e.message;
  }
}

watch(id, () => {
  panelHp.value = '';
  panelHpDirty.value = false;
});
</script>

<template>
  <ModuleDetailHeader
    :module="module"
    :module-id="id"
    :rack-modules="rackModules"
    :error="error"
    @reload="load"
  />
  <template v-if="module">
    <div class="row reanalyze-row">
      <button
        style="margin: 0; white-space: nowrap"
        :disabled="reanalyzing || retailerPagesExist"
        :title="reanalyzeTitle"
        data-test="reanalyze-components"
        @click="reanalyzeComponents"
      >
        {{ reanalyzing ? 'Queuing…' : 'Re-analyze components' }}
      </button>
      <button
        style="margin: 0; white-space: nowrap"
        :disabled="rebuilding"
        :title="rebuildTitle"
        data-test="rebuild-analysis"
        @click="rebuildAnalysis"
      >
        {{ rebuilding ? 'Queuing…' : 'Rebuild analysis' }}
      </button>
      <button
        v-if="module.panel && ['upload', 'image'].includes(module.panel.source)"
        type="button"
        class="secondary"
        style="margin: 0; white-space: nowrap"
        data-test="panel-trim"
        :disabled="trimmingPanel || module.panel.trimmed"
        :title="
          module.panel.trimmed
            ? 'This picture has already been cut down to the front plate'
            : 'Cut the picture down to the front plate — the markers stay on the hardware they point at'
        "
        @click="trimPanel"
      >
        {{ trimmingPanel ? 'Trimming…' : module.panel.trimmed ? 'Panel trimmed' : 'Trim panel' }}
      </button>
      <button
        v-if="orphanMarkers > 0"
        type="button"
        class="secondary"
        style="margin: 0; white-space: nowrap"
        data-test="panel-relink"
        :disabled="relinking"
        title="Match the markers that name no component back to the components they name"
        @click="relinkMarkers"
      >
        {{ relinking ? 'Tidying…' : `Tidy ${orphanMarkers} stray marker(s)` }}
      </button>
    </div>
    <p v-if="reanalyzeNotice" class="muted" data-test="reanalyze-notice">{{ reanalyzeNotice }}</p>
    <p v-if="reanalyzeError" class="error" data-test="reanalyze-error">{{ reanalyzeError }}</p>
    <p v-if="rebuildNotice" class="muted" data-test="rebuild-notice">{{ rebuildNotice }}</p>
    <p v-if="rebuildError" class="error" data-test="rebuild-error">{{ rebuildError }}</p>

    <details open class="panel" data-test="panel">
      <summary>
        <h2>Front panel</h2>
        <span class="summary-count">
          <template v-if="module.panel">{{ module.panel.components.length }} placed</template>
          <template v-else>none yet</template>
        </span>
      </summary>
      <div class="panel-body">
        <PanelJacksSection v-if="module.panel" :module="module" :arranging="arranging" />
        <p v-if="!module.panel" class="muted" data-test="no-panel">
          No panel picture yet — the app builds one once the manual has been analyzed, or you can
          supply your own below.
        </p>

        <label for="panel-upload">
          Supply your own panel picture (PNG, JPEG, GIF or WebP, up to 12MB)
        </label>
        <p class="muted" style="margin-top: 0">
          Upload a file or enter a direct image URL. A straight-on shot of the front plate works
          best. Leave the width blank and it is measured off the picture — a shot that takes in an
          expander sets the module's width to what it actually shows, so the rack is not drawn
          stretched. The components are located on it in the background, so the markers appear once
          that job finishes. Everyone with this module in a rack sees the picture you supply.
        </p>
        <div class="row">
          <input
            id="panel-hp"
            v-model="panelHp"
            style="max-width: 10rem"
            placeholder="Width in HP (optional)"
            data-test="panel-hp"
            @input="panelHpDirty = true"
          />
          <input
            id="panel-upload"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            data-test="panel-upload"
            :disabled="panelUploading"
            @change="onPanelChosen"
          />
          <input
            v-model="panelUrl"
            type="url"
            style="min-width: min(28rem, 100%)"
            placeholder="https://example.com/panel.png"
            aria-label="Panel image URL"
            data-test="panel-url"
            :disabled="panelUploading"
            @keyup.enter="downloadPanel"
          />
          <button
            type="button"
            data-test="panel-url-submit"
            :disabled="panelUploading || !panelUrl.trim()"
            @click="downloadPanel"
          >
            Download from URL
          </button>
          <button
            v-if="module.panel?.source === 'upload'"
            class="danger"
            data-test="remove-panel"
            @click="removePanel"
          >
            Remove supplied picture
          </button>
        </div>
        <p v-if="panelError" class="error" data-test="panel-error">{{ panelError }}</p>
      </div>
    </details>

    <details v-if="module.summary" open class="panel" data-test="summary">
      <summary>
        <h2>Summary</h2>
      </summary>
      <div class="panel-body">
        <p style="white-space: pre-wrap">{{ module.summary }}</p>
      </div>
    </details>
  </template>
</template>
