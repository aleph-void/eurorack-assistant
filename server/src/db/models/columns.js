// Column shapes every table in the schema repeats.
//
// The migrations in migrations/ remain the source of truth for the schema —
// these are the model-side mirror of what they create.

import { DataTypes } from 'sequelize';

// Every table's surrogate key: `id serial primary key`.
export const id = { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true };
