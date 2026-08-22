import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

// Some of what a click starts finishes on a TASK rather than a microtask —
// the FileReader behind an upload, a debounce — and `flushPromises()` cannot
// see past that. Waits for what the click was for, rather than betting one
// fixed tick against however loaded the machine running the suite is.
export async function waitFor(done, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await flushPromises();
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Fresh pinia per mount + shared mount options for view tests.
export function testGlobal() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return {
    plugins: [pinia],
    stubs: {
      RouterLink: { template: '<a><slot /></a>' },
      RouterView: { template: '<div />' },
    },
  };
}

// A panel that is not open has not been built (src/lazyPanel.js), so a test
// that reaches inside one opens it first — which is what a person does. Opens
// every <details> on the page, since a test is usually after one particular
// section and should not have to say which.
export async function openPanels(wrapper) {
  for (const details of wrapper.findAll('details')) {
    if (details.element.open) continue;
    details.element.open = true;
    await details.trigger('toggle');
  }
}

// Typing into an autocomplete picker, then taking the highlighted match with
// Enter — how a cable is named rather than clicked together.
export async function pick(wrapper, test, text) {
  const input = wrapper.find(`[data-test="${test}"]`);
  await input.trigger('focus');
  await input.setValue(text);
  await input.trigger('keydown', { key: 'Enter' });
  return input;
}

// A rack row that has never been opened has not been built either
// (RacksView's `openedRows`: a collapsed row's panels were downloaded for
// nothing), so a test that reaches into one opens it first — which is what a
// person does before dragging a module into a row.
export async function openRackRows(wrapper) {
  for (const toggle of wrapper.findAll('[data-test^="row-collapse-"]')) {
    if (toggle.attributes('aria-expanded') === 'true') continue;
    await toggle.trigger('click');
  }
}
