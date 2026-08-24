// A patch as a file: written out as JSON, and read back in — here or on
// somebody else's install.
//
// The database stores a patch against ids: which module record an instance is,
// which component row a cable end is. None of those ids mean anything anywhere
// else, so the document is written entirely in NAMES — manufacturer and model
// for an instance, the jack's label for a cable end — and the instances are
// numbered within the document so cables, settings and links have something
// short to point at.
//
// Reading one back resolves those names against the modules the importing user
// actually has, and what it cannot resolve it keeps as a name. That is not a
// fallback bolted on here: patch_modules.module_id and the component ids on
// cables are nullable exactly so a patch survives modules it cannot see, which
// is what makes a patch from a stranger's rack render at all.

// One import point for the three halves of that: what a document may be
// (services/patchDocumentLimits.js), writing one (services/patchExport.js),
// reading one as bytes (services/patchDocumentParse.js) and resolving it
// against a user's rack (services/patchImport.js).

export { exportPatchDocument, patchFileName } from './patchExport.js';
export { DocumentError, parsePatchDocument } from './patchDocumentParse.js';
export { importPatchDocument } from './patchImport.js';
