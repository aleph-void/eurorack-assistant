// Passing notifications, for the things a page cannot say where the user is
// looking.
//
// Every view reports into its own panel, which works only while the user is
// reading that panel: an inline `.error` at the top of a long page is easy to
// miss while working at the bottom of it — a refused rack layout save reads as
// a button that did nothing — and a job finishing minutes after it was queued
// has no page of its own at all. A toast is that second channel: it appears
// over whatever is on screen, says what happened, and takes itself away.
//
// Exported as an object like `dialog`, so tests can spy on toast.error the
// same way they spy on api.get.

import { reactive } from 'vue';

// Newest first — the stack draws them in that order, so the latest is nearest
// the top of the screen.
export const toastState = reactive({ items: [] });

// How many stand at once. A rack import finishes dozens of jobs; the oldest
// drop off rather than filling the window with a wall of green.
const LIMIT = 4;

// A failure is read, not glanced at, so it stays up more than twice as long as
// a success — and hovering it stops the clock entirely (see holdToast).
const LIFETIME = { success: 5000, error: 12000, info: 7000 };

let nextId = 1;
const timers = new Map();

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function startTimer(item) {
  clearTimer(item.id);
  if (!item.timeout) return;
  timers.set(item.id, setTimeout(() => dismissToast(item.id), item.timeout));
}

export function dismissToast(id) {
  clearTimer(id);
  toastState.items = toastState.items.filter((item) => item.id !== id);
}

// Hovering (or focusing) a toast holds it there: a twelve-second error is
// still a message that can run out mid-sentence, and the pointer sitting on it
// is as clear a "still reading" as there is. Letting go starts a fresh count
// rather than resuming the old one.
export function holdToast(id) {
  clearTimer(id);
}

export function releaseToast(id) {
  const item = toastState.items.find((entry) => entry.id === id);
  if (item) startTimer(item);
}

export function clearToasts() {
  for (const id of [...timers.keys()]) clearTimer(id);
  toastState.items = [];
}

function push(kind, message, { title = '', timeout = LIFETIME[kind] } = {}) {
  const text = String(message ?? '').trim();
  if (!text && !title) return null;
  // The same thing happening again — twenty modules' manuals found, one after
  // another — counts up on the toast already on screen instead of stacking
  // twenty copies of itself.
  const same = toastState.items.find(
    (item) => item.kind === kind && item.message === text && item.title === title
  );
  if (same) {
    same.count += 1;
    startTimer(same);
    return same.id;
  }
  const item = reactive({ id: nextId++, kind, title, message: text, count: 1, timeout });
  toastState.items = [item, ...toastState.items];
  // Over the limit, the oldest goes: the newest thing to happen is the one
  // worth the room.
  for (const dropped of toastState.items.slice(LIMIT)) clearTimer(dropped.id);
  toastState.items = toastState.items.slice(0, LIMIT);
  startTimer(item);
  return item.id;
}

export const toast = {
  /** Something worked: drawn green. */
  success: (message, options) => push('success', message, options),
  /** Something failed, or was refused: drawn red. */
  error: (message, options) => push('error', message, options),
  /** Neither — something is under way, or worth knowing. */
  info: (message, options) => push('info', message, options),
};
