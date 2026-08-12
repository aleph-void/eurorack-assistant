// Sequelize models for the schema in migrations/. The SQL migrations remain
// the source of truth for the schema (models are never sync()ed); attribute
// and column names are kept in snake_case so model JSON matches the API's
// existing response shapes.

import { DataTypes } from 'sequelize';

const id = { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true };

export function defineModels(sequelize) {
  const define = (name, attributes, options) =>
    sequelize.define(name, attributes, { freezeTableName: true, ...options });

  const User = define(
    'User',
    {
      id,
      username: { type: DataTypes.TEXT, allowNull: false, unique: true },
      password_hash: { type: DataTypes.TEXT, allowNull: false },
      is_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      must_change_password: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'users', createdAt: 'created_at', updatedAt: false }
  );

  const Session = define(
    'Session',
    {
      id,
      token: { type: DataTypes.TEXT, allowNull: false, unique: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'sessions', createdAt: 'created_at', updatedAt: false }
  );

  const AppConfig = define(
    'AppConfig',
    {
      key: { type: DataTypes.TEXT, primaryKey: true },
      value: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'app_config', timestamps: false }
  );

  const Module = define(
    'Module',
    {
      id,
      manufacturer: { type: DataTypes.TEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      manual_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      analysis_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      summary: { type: DataTypes.TEXT },
    },
    { tableName: 'modules', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const Manual = define(
    'Manual',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
      filename: { type: DataTypes.TEXT, allowNull: false },
      original_name: { type: DataTypes.TEXT },
      source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'found' },
    },
    { tableName: 'manuals', createdAt: 'created_at', updatedAt: false }
  );

  const UserModule = define(
    'UserModule',
    {
      user_id: { type: DataTypes.INTEGER, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, primaryKey: true },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    { tableName: 'user_modules', createdAt: 'created_at', updatedAt: false }
  );

  const ModuleComponent = define(
    'ModuleComponent',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      type: { type: DataTypes.TEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      voltage_min: { type: DataTypes.REAL },
      voltage_max: { type: DataTypes.REAL },
      polarity: { type: DataTypes.TEXT },
    },
    { tableName: 'module_components', createdAt: 'created_at', updatedAt: false }
  );

  const Note = define(
    'Note',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      title: { type: DataTypes.TEXT },
      body: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'notes', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const NoteModule = define(
    'NoteModule',
    {
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'note_modules', timestamps: false }
  );

  const NoteComponent = define(
    'NoteComponent',
    {
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
      component_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'note_components', timestamps: false }
  );

  const Question = define(
    'Question',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      prompt: { type: DataTypes.TEXT, allowNull: false },
      answer: { type: DataTypes.TEXT },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      error: { type: DataTypes.TEXT },
      answered_at: { type: DataTypes.DATE },
    },
    { tableName: 'questions', createdAt: 'created_at', updatedAt: false }
  );

  const QuestionModule = define(
    'QuestionModule',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_modules', timestamps: false }
  );

  const QuestionComponent = define(
    'QuestionComponent',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      component_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_components', timestamps: false }
  );

  const Job = define(
    'Job',
    {
      id,
      type: { type: DataTypes.TEXT, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
      module_id: { type: DataTypes.INTEGER },
      question_id: { type: DataTypes.INTEGER },
      payload: { type: DataTypes.TEXT },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      error: { type: DataTypes.TEXT },
    },
    { tableName: 'jobs', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // Associations. pg-mem (the test database) cannot parse the parenthesized
  // joins Sequelize emits for belongsToMany eager loads, so link tables are
  // modeled explicitly and traversed with hasMany/belongsTo include chains,
  // which produce flat joins.
  Session.belongsTo(User, { foreignKey: 'user_id' });

  Module.hasMany(UserModule, { foreignKey: 'module_id' });
  UserModule.belongsTo(Module, { foreignKey: 'module_id' });

  Module.hasMany(Manual, { foreignKey: 'module_id' });
  Manual.belongsTo(Module, { foreignKey: 'module_id' });

  Module.hasMany(ModuleComponent, { foreignKey: 'module_id' });
  ModuleComponent.belongsTo(Module, { foreignKey: 'module_id' });

  Note.hasMany(NoteModule, { foreignKey: 'note_id' });
  NoteModule.belongsTo(Note, { foreignKey: 'note_id' });
  NoteModule.belongsTo(Module, { foreignKey: 'module_id' });

  Note.hasMany(NoteComponent, { foreignKey: 'note_id' });
  NoteComponent.belongsTo(Note, { foreignKey: 'note_id' });
  NoteComponent.belongsTo(ModuleComponent, { foreignKey: 'component_id' });

  Question.hasMany(QuestionModule, { foreignKey: 'question_id' });
  QuestionModule.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionModule.belongsTo(Module, { foreignKey: 'module_id' });

  Question.hasMany(QuestionComponent, { foreignKey: 'question_id' });
  QuestionComponent.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionComponent.belongsTo(ModuleComponent, { foreignKey: 'component_id' });

  Job.belongsTo(User, { foreignKey: 'user_id' });
  Job.belongsTo(Module, { foreignKey: 'module_id' });
  Job.belongsTo(Question, { foreignKey: 'question_id' });

  return {
    User,
    Session,
    AppConfig,
    Module,
    Manual,
    UserModule,
    ModuleComponent,
    Note,
    NoteModule,
    NoteComponent,
    Question,
    QuestionModule,
    QuestionComponent,
    Job,
  };
}
