// What a storyboard may say, in one place: what an element of a composition
// can be, what it can do in a scene, and the words and colours each is
// drawn with. Mirrors ELEMENT_KINDS and CELL_ACTIONS in
// server/src/services/compositions.js, which is what the server validates
// against — anything offered here that the server would refuse is a bug, so
// the two lists are kept in the same order.

export const ELEMENT_KINDS = [
  { key: 'voice', label: 'Voice', color: '#f59e0b' },
  { key: 'rhythm', label: 'Rhythm', color: '#ef4444' },
  { key: 'modulation', label: 'Modulation', color: '#3b82f6' },
  { key: 'effect', label: 'Effect', color: '#a855f7' },
  { key: 'texture', label: 'Texture', color: '#14b8a6' },
  { key: 'control', label: 'Control', color: '#eab308' },
  { key: 'other', label: 'Other', color: '#9ca3af' },
];

const KIND_BY_KEY = new Map(ELEMENT_KINDS.map((k) => [k.key, k]));
export const kindLabel = (key) => KIND_BY_KEY.get(key)?.label ?? 'Other';
export const kindColor = (key) => KIND_BY_KEY.get(key)?.color ?? KIND_BY_KEY.get('other').color;

// What an element does in a scene. The symbol is what the grid draws in the
// cell — a storyboard is read at a glance, across — and the label is the
// word under it and in the picker.
export const CELL_ACTIONS = [
  { key: 'enter', label: 'Enters', symbol: '▶' },
  { key: 'hold', label: 'Holds', symbol: '—' },
  { key: 'change', label: 'Changes', symbol: '△' },
  { key: 'exit', label: 'Exits', symbol: '■' },
];

const ACTION_BY_KEY = new Map(CELL_ACTIONS.map((a) => [a.key, a]));
export const actionLabel = (key) => ACTION_BY_KEY.get(key)?.label ?? key;
export const actionSymbol = (key) => ACTION_BY_KEY.get(key)?.symbol ?? '·';

// A scene's length as a person types it — "1:30", "90", "2m" — into the
// seconds the server stores, or null for nothing / something unreadable.
export function parseDuration(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) return null;
  const clock = raw.match(/^(\d+):([0-5]?\d)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const minutes = raw.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/);
  if (minutes) return Math.round(Number(minutes[1]) * 60);
  const seconds = raw.match(/^(\d+(?:\.\d+)?)\s*s?(?:ec)?$/);
  if (seconds) return Number(seconds[1]);
  return NaN;
}

// Seconds back into "1:30". Nothing for null: an untimed scene is not 0:00.
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '';
  const total = Math.round(Number(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// What a mapping binds an element to, for the picker and the chips.
export const TARGET_KINDS = [
  { key: 'module', label: 'A module instance' },
  { key: 'component', label: 'One control or jack' },
  { key: 'group', label: 'A bus' },
  { key: 'cable', label: 'A cable' },
];
