// Reading a patch file, treating every field in it as hostile.
//
// Nothing here touches the database: this turns bytes into a document whose
// shape is known, and services/patchImport.js is what resolves the names in
// it against the modules a user actually has.

import {
  JACK_TYPES,
  LIMITS,
  LINK_KINDS,
  PATCH_FORMAT,
  PATCH_FORMAT_VERSION,
} from './patchDocumentLimits.js';

// Everything below treats the document as hostile: it came out of a file.

export class DocumentError extends Error {}
const fail = (message) => {
  throw new DocumentError(message);
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A required string, trimmed and length-capped.
function text(value, label, { max = LIMITS.text, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') fail(`${label} must be text`);
  const out = String(value).trim().slice(0, max);
  if (!out && required) fail(`${label} is required`);
  return out || null;
}

function list(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be a list`);
  if (value.length > max) fail(`${label} has more than ${max} entries`);
  return value;
}

const integer = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
};

function componentType(value, label, { jack = false } = {}) {
  const type = text(value, label, { required: false });
  if (type === null) return null;
  if (jack && !JACK_TYPES.includes(type)) fail(`${label} must be one of ${JACK_TYPES.join(', ')}`);
  return type;
}

// The document, checked into a shape the writer below can trust. Kept apart
// from the writing so a bad file is rejected before anything is created.
export function parsePatchDocument(input) {
  if (!isObject(input)) fail('not a patch document');
  // A bare patch body is accepted too, so a document pasted without its
  // envelope still reads.
  const envelope = isObject(input.patch) ? input : { patch: input };
  if (input.format !== undefined && input.format !== PATCH_FORMAT) {
    fail(`unknown format '${String(input.format).slice(0, 60)}'`);
  }
  if (input.version !== undefined && integer(input.version, -1) > PATCH_FORMAT_VERSION) {
    fail(`this file was written by a newer version (${input.version}) of the app`);
  }
  const body = envelope.patch;
  if (!isObject(body)) fail('not a patch document');

  const groups = list(body.groups, 'groups', LIMITS.groups).map((g, at) => {
    if (!isObject(g)) fail('every group must be an object');
    return {
      name: text(g.name, `group ${at + 1} name`),
      description: text(g.description, 'group description', { required: false }),
      position: integer(g.position, at),
    };
  });

  const seenRefs = new Set();
  const modules = list(body.modules, 'modules', LIMITS.modules).map((m, at) => {
    if (!isObject(m)) fail('every module must be an object');
    const ref = integer(m.ref, at + 1);
    if (seenRefs.has(ref)) fail(`two modules share the reference ${ref}`);
    seenRefs.add(ref);
    const groupName = text(m.group, 'module group', { required: false });
    if (groupName && !groups.some((g) => g.name === groupName)) {
      fail(`module ${at + 1} is in a bus '${groupName}' the file does not define`);
    }
    return {
      ref,
      manufacturer: text(m.manufacturer, `module ${at + 1} manufacturer`, { required: false }) ?? '',
      module_name: text(m.module_name ?? m.name, `module ${at + 1} name`),
      instance: Math.max(1, integer(m.instance, 1)),
      rack_name: text(m.rack_name, `module ${at + 1} rack name`, { required: false }),
      label: text(m.label, 'module label', { required: false }),
      group: groupName,
      external: Boolean(m.external),
      ports: list(m.ports, `module ${at + 1} ports`, LIMITS.ports).map((p, pat) => {
        if (!isObject(p)) fail('every port must be an object');
        const type = text(p.type, 'port type', { required: false }) ?? 'input_jack';
        if (!JACK_TYPES.includes(type)) fail(`port type must be one of ${JACK_TYPES.join(', ')}`);
        return {
          name: text(p.name, 'port name'),
          type,
          port_kind: text(p.port_kind, 'port kind', { required: false }),
          description: text(p.description, 'port description', { required: false }),
          position: integer(p.position, pat),
        };
      }),
    };
  });

  // A reference that points at no instance is the one thing that cannot be
  // repaired on the way in, so it is refused rather than guessed at.
  const end = (value, label) => {
    if (!isObject(value)) fail(`${label} must be an object`);
    const ref = integer(value.module, -1);
    if (!seenRefs.has(ref)) fail(`${label} refers to module ${value.module}, which is not in the file`);
    return {
      module: ref,
      jack: text(value.jack ?? value.component, `${label} jack`),
      type: componentType(value.type, `${label} type`, { jack: true }),
    };
  };

  const cables = list(body.cables, 'cables', LIMITS.cables).map((c, at) => {
    if (!isObject(c)) fail('every cable must be an object');
    return {
      from: end(c.from, `cable ${at + 1} 'from'`),
      to: end(c.to, `cable ${at + 1} 'to'`),
      note: text(c.note, 'cable note', { required: false, max: LIMITS.body }),
      optional: Boolean(c.optional),
      stacked: Boolean(c.stacked),
      alt_group: text(c.alt_group, 'cable alt_group', { required: false }),
    };
  });

  const settings = list(body.settings, 'settings', LIMITS.settings).map((s, at) => {
    if (!isObject(s)) fail('every setting must be an object');
    const ref = integer(s.module, -1);
    if (!seenRefs.has(ref)) fail(`setting ${at + 1} refers to a module that is not in the file`);
    // A menu parameter of the whole module names no control at all, so the
    // control is only compulsory for a setting that is a control's position.
    const parameter = text(s.parameter, `setting ${at + 1} parameter`, { required: false });
    return {
      module: ref,
      control: text(s.control ?? s.component, `setting ${at + 1} control`, {
        required: !parameter,
      }),
      type: componentType(s.type, `setting ${at + 1} type`),
      parameter,
      value: text(s.value, `setting ${at + 1} value`, { max: LIMITS.body }),
    };
  });

  const links = list(body.links, 'links', LIMITS.links).map((l, at) => {
    if (!isObject(l)) fail('every link must be an object');
    const a = integer(l.a, -1);
    const b = integer(l.b, -1);
    if (!seenRefs.has(a) || !seenRefs.has(b)) {
      fail(`link ${at + 1} joins a module that is not in the file`);
    }
    if (a === b) fail(`link ${at + 1} joins an instance to itself`);
    const kind = text(l.kind, 'link kind', { required: false }) ?? 'expander';
    if (!LINK_KINDS.includes(kind)) fail(`link kind must be one of ${LINK_KINDS.join(', ')}`);
    return {
      a,
      b,
      kind,
      description: text(l.description, 'link description', { required: false }),
      jacks: list(l.jacks, `link ${at + 1} jacks`, LIMITS.jacks).map((j) => {
        if (!isObject(j)) fail('every linked jack must be an object');
        return {
          a: text(j.a, 'linked jack name'),
          a_type: componentType(j.a_type, 'linked jack type', { jack: true }),
          b: text(j.b, 'linked jack name'),
          b_type: componentType(j.b_type, 'linked jack type', { jack: true }),
        };
      }),
    };
  });

  return {
    name: text(body.name, 'patch name', { required: false }),
    description: text(body.description, 'patch description', { required: false, max: LIMITS.body }),
    rack_name: text(body.rack_name, 'rack name', { required: false }),
    system_name: text(body.system_name, 'system name', { required: false }),
    groups,
    modules,
    cables,
    settings,
    links,
  };
}

// Which of the user's modules the document's instances mean. Only modules the
// user actually has are resolved: a name that matches a module record they do
// not own stays a name, so importing a patch never quietly hands anybody a
