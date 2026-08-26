// Notes and questions, and what each of them is about.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineNotesModels(define) {
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

  const NotePatch = define(
    'NotePatch',
    {
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
      patch_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'note_patches', timestamps: false }
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

  const QuestionManual = define(
    'QuestionManual',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      manual_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_manuals', timestamps: false }
  );

  const QuestionAnswer = define(
    'QuestionAnswer',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      source_question_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_answers', timestamps: false }
  );

  const QuestionNote = define(
    'QuestionNote',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_notes', timestamps: false }
  );

  const QuestionCapture = define(
    'QuestionCapture',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      capture_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_captures', timestamps: false }
  );

  // A recording a question is about (migration 043): the waveform picture
  // rendered from it and the levels measured off it ride along with the
  // question, since no backend can listen to the file itself.
  const QuestionAudio = define(
    'QuestionAudio',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      audio_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_audio', timestamps: false }
  );

  // A patch a question is about: it brings the patch's modules into scope and
  // rides along as a document describing the whole patch.
  const QuestionPatch = define(
    'QuestionPatch',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      patch_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_patches', timestamps: false }
  );

  return { Note, NoteModule, NoteComponent, NotePatch, Question, QuestionModule, QuestionComponent, QuestionManual, QuestionAnswer, QuestionNote, QuestionCapture, QuestionAudio, QuestionPatch };
}
