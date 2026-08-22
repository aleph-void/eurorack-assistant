// Sequelize models for the schema in migrations/. The migrations remain
// the source of truth for the schema (models are never sync()ed); attribute
// and column names are kept in snake_case so model JSON matches the API's
// existing response shapes.
//
// The tables themselves live one domain per file under db/models/ — sixty
// tables in one listing is a file nobody reads twice — and the association
// graph, which does have to be read whole, is db/models/associations.js.

import { defineAccountsModels } from './models/accounts.js';
import { defineModulesModels } from './models/modules.js';
import { defineRacksModels } from './models/racks.js';
import { definePatchesModels } from './models/patches.js';
import { defineNotesModels } from './models/notes.js';
import { defineScopeModels } from './models/scope.js';
import { defineJobsModels } from './models/jobs.js';
import { associate } from './models/associations.js';

export function defineModels(sequelize) {
  const define = (name, attributes, options) =>
    sequelize.define(name, attributes, { freezeTableName: true, ...options });

  return associate({
    ...defineAccountsModels(define),
    ...defineModulesModels(define),
    ...defineRacksModels(define),
    ...definePatchesModels(define),
    ...defineNotesModels(define),
    ...defineScopeModels(define),
    ...defineJobsModels(define),
  });
}
