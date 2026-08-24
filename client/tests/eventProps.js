// jsdom 30 implements PointerEvent, which jsdom 25 did not. That is the fix
// this file works around, not a bug: `trigger('pointerdown', { clientX })` used
// to fall back to a plain Event, where clientX was an expando nobody minded.
// A real PointerEvent has it as a getter-only accessor on MouseEvent.prototype
// instead — and @vue/test-utils, having already passed clientX to the
// constructor, writes it a second time afterwards, guarded by a check that only
// looks at the event's OWN prototype (vue-test-utils.cjs.js `canSetProperty`).
// PointerEvent.prototype does not own clientX; MouseEvent.prototype two links up
// does, so the guard misses it and the redundant write throws.
//
// The value is right either way — the constructor took it from the same object
// — so the write only has to stop being fatal. Every getter-only accessor an
// event class INHERITS is given an own accessor that keeps the inherited getter
// and adds a setter, which shadows it on the instance the way the expando did.
function inheritedGetterOnlyKeys(ctor) {
  const own = ctor.prototype;
  const keys = new Map();
  for (let proto = Object.getPrototypeOf(own); proto; proto = Object.getPrototypeOf(proto)) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (key === 'constructor') continue;
      if (!descriptor.get || descriptor.set) continue;
      if (Object.getOwnPropertyDescriptor(own, key)) continue;
      if (keys.has(key)) continue;
      keys.set(key, descriptor.get);
    }
  }
  return keys;
}

export function makeEventPropsWritable(target = globalThis) {
  const Base = target.Event;
  if (typeof Base !== 'function') return;
  for (const name of Object.getOwnPropertyNames(target)) {
    if (!name.endsWith('Event')) continue;
    const ctor = target[name];
    if (typeof ctor !== 'function' || ctor === Base) continue;
    if (!(ctor.prototype instanceof Base)) continue;
    for (const [key, get] of inheritedGetterOnlyKeys(ctor)) {
      Object.defineProperty(ctor.prototype, key, {
        configurable: true,
        enumerable: true,
        get,
        set(value) {
          Object.defineProperty(this, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      });
    }
  }
}

makeEventPropsWritable();
