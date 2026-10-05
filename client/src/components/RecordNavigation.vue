<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useDetailStore } from '../stores/detail.js';
const route = useRoute();
const detail = useDetailStore();

// The same grouped sections on every page of a module or patch. Known empty
// sections fold away, while unknown counts and the current page stay visible.
// Component type pages also carry their own chip navigation.
const MODULE_PAGES = [
  { path: '', label: 'Front panel & summary', exact: true },
  { path: '/jacks/input', label: 'Input jacks', group: 'panel', countKey: 'input_jack' },
  { path: '/jacks/output', label: 'Output jacks', group: 'panel', countKey: 'output_jack' },
  {
    path: '/jacks/bidirectional',
    label: 'Bidirectional jacks',
    group: 'panel',
    countKey: 'bidirectional_jack',
  },
  { path: '/components', label: 'Controls & components', group: 'panel', countKey: 'components' },
  { path: '/values', label: 'Component values', group: 'panel', countKey: 'values' },
  { path: '/parameters', label: 'Menu parameters', group: 'panel', countKey: 'parameters' },
  {
    path: '/normalizations',
    label: 'Normalled connections',
    group: 'signal',
    countKey: 'normalizations',
  },
  { path: '/switches', label: 'Routing switches', group: 'signal', countKey: 'routing_switches' },
  { path: '/routes', label: 'Internal signal paths', group: 'signal', countKey: 'routes' },
  { path: '/pairs', label: 'Stereo pairs', group: 'signal', countKey: 'pairs' },
  { path: '/expanders', label: 'Expander panels', group: 'signal', countKey: 'expanders' },
  { path: '/bridges', label: 'Dual panels', group: 'signal', countKey: 'bridges' },
  { path: '/documents', label: 'Documents', group: 'reference', countKey: 'documents', always: true },
  { path: '/videos', label: 'Videos', group: 'reference', countKey: 'videos' },
  { path: '/audio', label: 'Recordings', group: 'reference' },
  { path: '/links', label: 'Links', group: 'reference' },
  { path: '/scope', label: 'Oscilloscope', group: 'tools' },
  { path: '/notes', label: 'Notes', group: 'work', countKey: 'notes', always: true },
  { path: '/questions', label: 'Questions & answers', group: 'work' },
];

// The group headings. "Switches" and "Routing switches" stop colliding here:
// one sits under the panel heading with the other controls, the other under
// signal behavior with the rest of what the manual says happens inside.
const MODULE_GROUPS = [
  { key: 'panel', label: 'On the panel' },
  { key: 'signal', label: 'Signal behavior' },
  { key: 'reference', label: 'Reference' },
  { key: 'work', label: 'Notes & questions' },
  { key: 'tools', label: 'Measurement' },
];

const PATCH_PAGES = [
  { path: '', label: 'Diagram', exact: true },
  { path: '/cables', label: 'Cables', group: 'patch', countKey: 'cables' },
  { path: '/settings', label: 'Control settings', group: 'patch', countKey: 'settings' },
  { path: '/flow', label: 'Signal flow', group: 'patch' },
  { path: '/modules', label: 'Modules in this patch', group: 'patch', countKey: 'modules' },
  { path: '/gear', label: 'Module links, buses & gear', group: 'patch', countKey: 'gear' },
  { path: '/audio', label: 'Recordings', group: 'reference' },
  { path: '/links', label: 'Links', group: 'reference' },
  { path: '/scope', label: 'Oscilloscope', group: 'work' },
  { path: '/notes', label: 'Notes', group: 'work' },
  { path: '/questions', label: 'Questions', group: 'work' },
  { path: '/compositions', label: 'Compositions', group: 'work' },
];

const PATCH_GROUPS = [
  { key: 'patch', label: 'Connections & setup' },
  { key: 'reference', label: 'Reference' },
  { key: 'work', label: 'Your work' },
];

const detailPages = computed(() => (detail.kind === 'patch' ? PATCH_PAGES : MODULE_PAGES));
const detailHeading = computed(() => detail.kind === 'module' ? 'Explore this module' : (detail.label || 'This patch'));

// The record's front page stands alone under its name; every other page
// stands in its group.
const detailIndexPage = computed(() => detailPages.value.find((page) => page.exact));

// What the header reported for a page: a number, or null for "not known",
// which is how a page whose rows are not in the payload stays visible.
function pageCount(page) {
  if (!page.countKey) return null;
  const count = detail.counts?.[page.countKey];
  return typeof count === 'number' ? count : null;
}

// A page the reader is ON is never folded away, empty or not: hiding the
// link that is lit is how a drawer stops making sense.
const isCurrentPage = (page) => {
  const path = route.path || route.fullPath?.split('?')[0];
  return path === `${detailBase.value}${page.path}` ||
    (page.path === '/components' && path?.startsWith(`${detailBase.value}/parts/`));
};

const detailGroups = computed(() => {
  const groups = detail.kind === 'patch' ? PATCH_GROUPS : MODULE_GROUPS;
  return groups
    .map((group) => {
      const members = detailPages.value.filter((page) => page.group === group.key);
      const empty = members.filter((page) => !page.always && pageCount(page) === 0 && !isCurrentPage(page));
      return { ...group, shown: members.filter((page) => !empty.includes(page)), empty };
    })
    .filter((group) => group.shown.length || group.empty.length);
});

// Empty sections open per group; the record heading collapses the whole
// navigation panel when the reader wants more room for the page content.
// Both start over when the drawer moves to another record.
const emptyOpen = ref({});
const recordOpen = ref(true);
watch(
  () => [detail.kind, detail.id],
  () => {
    emptyOpen.value = {};
    recordOpen.value = true;
  }
);

// Previous/next stay in the rack the reader came from, so the sub-page links
// have to carry it as well or the walk through a rack ends at the first jump.
const detailBase = computed(() => {
  if (!detail.kind || !detail.id) return null;
  return detail.kind === 'patch' ? `/patches/${detail.id}` : `/modules/${detail.id}`;
});
const detailSuffix = computed(() =>
  detail.kind === 'module' && route.query.rack ? `?rack=${route.query.rack}` : ''
);
const detailHref = (page) => `${detailBase.value}${page.path}${detailSuffix.value}`;
const pageLocation = (page) => isCurrentPage(page)
  ? (page.path === '/components' && route.path?.includes('/parts/') ? 'location' : 'page')
  : undefined;
</script>

<template>
  <nav v-if="detailBase" class="record-nav" aria-label="Record sections">
    <button
      class="nav-heading nav-record-toggle"
      type="button"
      :aria-expanded="recordOpen ? 'true' : 'false'"
      aria-controls="record-sections"
      data-test="nav-detail-heading"
      @click="recordOpen = !recordOpen"
    >
      {{ detailHeading }}
    </button>
    <div v-if="recordOpen" id="record-sections" class="record-sections">
      <RouterLink
        :to="detailHref(detailIndexPage)"
        class="nav-sub"
        active-class=""
        :class="{ current: isCurrentPage(detailIndexPage) }"
        :aria-current="isCurrentPage(detailIndexPage) ? 'page' : undefined"
        data-test="nav-detail-index"
      >
        {{ detailIndexPage.label }}
      </RouterLink>
      <div v-for="group in detailGroups" :key="group.key" class="record-group">
        <p class="nav-subheading" :data-test="`nav-group-${group.key}`">{{ group.label }}</p>
        <RouterLink
          v-for="page in group.shown"
          :key="page.path"
          :to="detailHref(page)"
          active-class=""
          :class="{ current: isCurrentPage(page) }"
          :aria-current="pageLocation(page)"
          class="nav-sub"
          :data-test="`nav-detail-${page.path.slice(1)}`"
        >
          {{ page.label }}
          <span v-if="pageCount(page)" class="nav-count">{{ pageCount(page) }}</span>
        </RouterLink>
        <template v-if="group.empty.length">
          <button
            class="nav-empty-toggle"
            type="button"
            :aria-expanded="emptyOpen[group.key] ? 'true' : 'false'"
            :data-test="`nav-empty-${group.key}`"
            @click="emptyOpen[group.key] = !emptyOpen[group.key]"
          >
            {{ emptyOpen[group.key] ? 'Hide empty pages' : `Empty pages (${group.empty.length})` }}
          </button>
          <template v-if="emptyOpen[group.key]">
            <RouterLink
              v-for="page in group.empty"
              :key="page.path"
              :to="detailHref(page)"
              active-class=""
              :class="{ current: isCurrentPage(page) }"
              :aria-current="pageLocation(page)"
              class="nav-sub nav-empty"
              :data-test="`nav-detail-${page.path.slice(1)}`"
            >
              {{ page.label }}
            </RouterLink>
          </template>
        </template>
      </div>
    </div>
  </nav>
</template>
