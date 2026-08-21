import { defineStore } from 'pinia';

// The record the page is about, so the nav drawer can offer that record's own
// sub-pages by name. A module page and a patch page are each a handful of
// routes over one record; the header of every one of them says which record
// it is showing, and gives up the claim on the way out. Nothing else writes.
//
// Claims are counted rather than named because a route swap mounts the
// arriving header BEFORE unmounting the departing one, and the two are
// usually the same kind and often the same record: comparing kind or id would
// have the page being left blank out the page being arrived at. A header only
// ever gives up the claim it was granted.
export const useDetailStore = defineStore('detail', {
  state: () => ({ kind: null, id: null, label: '', claim: 0 }),
  actions: {
    set(kind, id, label) {
      this.claim += 1;
      this.kind = kind;
      this.id = id == null ? null : String(id);
      this.label = label || '';
      return this.claim;
    },
    clear(claim) {
      if (claim !== this.claim) return;
      this.kind = null;
      this.id = null;
      this.label = '';
    },
  },
});
