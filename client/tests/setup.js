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
