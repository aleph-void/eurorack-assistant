<script setup>
import { toRef } from 'vue';
import { usePatchFacts } from './usePatchFacts.js';

const props = defineProps({
  patch: { type: Object, required: true },
});

const { modulesById, moduleLabel, conditionText } = usePatchFacts(toRef(props, 'patch'));

// ---- normalled connections ----
// Server-traced: each normalization is active until the cable that cancels it
// is patched, and its signals array names what actually arrives (following
// input→input chains through the patch's cables).
function signalText(s) {
  if (s.kind === 'cable') {
    const from = modulesById.value.get(s.from_patch_module_id);
    const via = s.via.length ? ` (via ${s.via.join(' → ')})` : '';
    return `${s.from_component_name} from ${moduleLabel(from)}${via}`;
  }
  if (s.kind === 'output') return `${s.component_name} (same module)`;
  if (s.kind === 'internal') return s.label;
  return 'nothing — the chain ends at an unpatched input';
}

function normalizationStatus(n) {
  if (!n.active) {
    const how = n.break_on === 'cable_out' ? 'out of' : 'into';
    return `a cable is patched ${how} ${n.break_component_name}`;
  }
  return `receives ${n.signals.map(signalText).join('; ')}`;
}
</script>

<template>
  <details v-if="patch.normalizations?.length" class="panel" data-test="normalled">
    <summary>
      <h2>Normalled connections in this patch</h2>
      <span class="summary-count">
        {{ patch.normalizations.length }}
        {{ patch.normalizations.length === 1 ? 'connection' : 'connections' }}
      </span>
    </summary>
    <div class="panel-body">
      <p class="muted">
        Built-in default connections. Each one stays active until the cable that cancels it is
        patched; chained normals are traced to the signal that actually arrives. Defaults that
        depend on a switch position show which setting they need.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th>Jack</th>
              <th>Normalled to</th>
              <th>Only when</th>
              <th>In this patch</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in patch.normalizations"
              :key="`${n.patch_module_id}-${n.normalization_id}`"
              :data-test="`normalled-${n.patch_module_id}-${n.normalization_id}`"
            >
              <td data-label="Module">{{ moduleLabel(modulesById.get(n.patch_module_id)) }}</td>
              <td data-label="Jack">{{ n.target_component_name }}</td>
              <td data-label="Normalled to">{{ n.source_component_name || n.source_label }}</td>
              <td data-label="Only when">
                {{ conditionText(n.condition) || 'always' }}
                <span v-if="n.exclusive" class="badge pending">one of several</span>
              </td>
              <td data-label="In this patch">
                <span class="badge" :class="n.active ? 'found' : 'pending'">
                  {{ n.active ? 'active' : 'overridden' }}
                </span>
                {{ normalizationStatus(n) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </details>
</template>
