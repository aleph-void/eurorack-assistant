// Links: what one is allowed to be, what it hangs off, and how it serializes.
//
// A link is user-typed text that the browser will eventually be told to
// follow, which makes exactly two things worth being strict about: the
// SCHEME (a `javascript:` or `data:` URL stored here is a stored cross-site
// script waiting for a renderer that forgets to check) and the OWNER (a link
// belongs to one module, patch, rack or system — the CHECK in migration 044
// says so, and this is where a request is held to it before the database
// has to be).
//
// Nothing here fetches anything. A link is an address kept next to the thing
// it is about, not a document the app holds: no request leaves the server
// when one is saved, so a link can never be a way to make the server knock
// on an address somebody chose for it.

import { userHasModule } from './racks.js';

export const MAX_URL_LENGTH = 2000;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

// The four things a link can hang off, in the order they are looked for.
export const LINK_OWNER_KEYS = ['module_id', 'patch_id', 'rack_id', 'system_id'];

const OWNER_LABELS = {
  module_id: 'module',
  patch_id: 'patch',
  rack_id: 'rack',
  system_id: 'system',
};

// The one owner a request names, or an error saying why it names none or
// too many. Returns { key, id } — the column to set and what to set it to.
export function readLinkOwner(body = {}) {
  const named = LINK_OWNER_KEYS.filter((key) => body[key] !== undefined && body[key] !== null);
  if (named.length === 0) {
    return { error: 'Name what the link is on: module_id, patch_id, rack_id or system_id' };
  }
  if (named.length > 1) {
    return { error: 'A link belongs to one record: name only one of module_id, patch_id, rack_id, system_id' };
  }
  const key = named[0];
  const id = Number(body[key]);
  if (!Number.isInteger(id) || id <= 0) return { error: `${key} must be a record id` };
  return { key, id };
}

// Whether this user may hang a link off that record. A module is shared
// between everyone who racked it, so "yours" means it is in one of your
// racks; the other three are owned outright.
export async function ownsLinkTarget(db, userId, { key, id }) {
  const { Patch, Rack, System } = db.models;
  if (key === 'module_id') return userHasModule(db, userId, id);
  if (key === 'patch_id') return Boolean(await Patch.findOne({ where: { id, user_id: userId } }));
  if (key === 'rack_id') return Boolean(await Rack.findOne({ where: { id, user_id: userId } }));
  if (key === 'system_id') return Boolean(await System.findOne({ where: { id, user_id: userId } }));
  return false;
}

export const linkOwnerLabel = (key) => OWNER_LABELS[key] ?? 'record';

// A URL the app will store, or an error. http and https only: everything
// else a browser understands at a link — javascript:, data:, blob:, file: —
// is either a script, a document pretending to be an address, or a path on
// the reader's own machine, and none of those is a link to a forum thread.
export function normalizeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { error: 'A link needs a URL' };
  if (raw.length > MAX_URL_LENGTH) {
    return { error: `URLs are limited to ${MAX_URL_LENGTH} characters` };
  }
  // A pasted address usually has no scheme; https is what a bare host means
  // in 2025, and guessing http would send the reader to the insecure one.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { error: 'That is not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Links must be http:// or https:// addresses' };
  }
  if (!url.hostname) return { error: 'That URL has no host' };
  return { url: url.toString() };
}

// What to call a link the user gave no name. The host without its www is
// what the reader recognises in a list — "modwiggler.com" rather than a
// hundred characters of query string.
export function titleFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export const linkJson = (row) => {
  const plain = row.get ? row.get({ plain: true }) : row;
  return {
    id: plain.id,
    module_id: plain.module_id,
    patch_id: plain.patch_id,
    rack_id: plain.rack_id,
    system_id: plain.system_id,
    url: plain.url,
    title: plain.title,
    description: plain.description,
    position: plain.position,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
  };
};

// The links on one record, in the order they were arranged. Used by the
// links routes and by anything that shows a record's links beside it.
export async function linksFor(db, userId, { key, id }) {
  const { ResourceLink } = db.models;
  const rows = await ResourceLink.findAll({
    where: { user_id: userId, [key]: id },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return rows.map(linkJson);
}
