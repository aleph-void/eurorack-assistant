import { createPinia, setActivePinia } from 'pinia';

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
