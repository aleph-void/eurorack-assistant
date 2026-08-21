// A section that is not open yet does not have to exist yet.
//
// A collapsed <details> is only HIDDEN by the browser: everything inside it is
// built, laid out and kept. On a patch of a whole studio that is thousands of
// nodes — a row per module, several times over — for sections nobody has
// opened, paid for on every load and on every reload after every edit.
//
// The body is held back until the first time the section is opened, and left
// in place from then on: closing and reopening is instant, nothing inside
// loses what was typed into it, and a section opened by default (the diagram,
// the cable list) is unaffected.

import { ref } from 'vue';

export function useLazyPanel(openByDefault = false) {
  const opened = ref(openByDefault);
  // <details> fires 'toggle' after its state changes, so this is simply
  // 'has it ever been open'.
  const onToggle = (event) => {
    if (event.target.open) opened.value = true;
  };
  return { opened, onToggle };
}
