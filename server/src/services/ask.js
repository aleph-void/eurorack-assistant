// Question answering, ported from eurorack-processor's ask.py and split into
// two phases. scopeQuestion determines which of the user's modules (and
// jacks) the question applies to and leaves the question 'scoped'; the user
// then reviews the scope in the GUI — adjusting modules and attaching manual
// documents, previous answers, and notes — before answerQuestion submits the
// question with exactly those attachments to the LLM backend.

import { extractJsonArray } from './json.js';
import { isProbablyPdf, manualPath } from './pdf.js';
import { userModuleIds } from './racks.js';

export const MAX_MANUALS = 10;

export const SCOPING_TEMPLATE = (moduleList, question) => `You are helping answer a question about a eurorack modular synthesizer system.

Here is the full list of modules in the system, as "manufacturer,module" lines:

${moduleList}

Question:
${question}

Which modules are in scope for this question? Select every module that is directly
mentioned, or that belongs to a category the question is about (e.g. "filters",
"sequencers", "delays"). If the question is about the whole system, select all modules.

Respond with ONLY a JSON array of objects, each with "manufacturer" and "module" keys,
copied exactly from the list above. Respond with [] if no modules are relevant.
`;

export async function determineScope(backend, question, modules) {
  const moduleList = modules
    .map((m) => `${m.manufacturer.trim()},${m.name.trim()}`)
    .join('\n');
  const response = await backend.completeText(SCOPING_TEMPLATE(moduleList, question));
  const selected = extractJsonArray(response);

  const byKey = new Map(
    modules.map((m) => [
      `${m.manufacturer.trim().toLowerCase()}|${m.name.trim().toLowerCase()}`,
      m,
    ])
  );
  const matched = [];
  const seen = new Set();
  for (const item of selected) {
    const key = `${String(item?.manufacturer || '').trim().toLowerCase()}|${String(
      item?.module || ''
    ).trim().toLowerCase()}`;
    const module = byKey.get(key);
    if (module && !seen.has(module.id)) {
      seen.add(module.id);
      matched.push(module);
    }
  }
  return matched;
}

// When a question is about specific input/output jacks, link those component
// records to the question (a question can touch several jacks across several
// modules).
export const COMPONENT_SCOPING_TEMPLATE = (componentList, question) => `You are helping answer a question about a eurorack modular synthesizer system.

Here are the input and output jacks of the modules relevant to the question,
as "id | module | jack name | type" lines:

${componentList}

Question:
${question}

Which specific jacks (if any) does this question directly pertain to? Only
select jacks the question is actually about (mentioned by name, or clearly
involved in the patch or signal path being asked about). A question may pertain
to jacks on more than one module. If the question is not about any specific
jack, select none.

Respond with ONLY a JSON array of the numeric ids of the pertinent jacks,
e.g. [3, 17]. Respond with [] if none apply.
`;

export async function determineComponentScope(backend, question, components) {
  if (components.length === 0) return [];
  const componentList = components
    .map((c) => `${c.id} | ${c.module_label} | ${c.name} | ${c.type}`)
    .join('\n');
  const response = await backend.completeText(COMPONENT_SCOPING_TEMPLATE(componentList, question));
  const selected = extractJsonArray(response);
  const byId = new Map(components.map((c) => [c.id, c]));
  const matched = [];
  const seen = new Set();
  for (const item of selected) {
    const id = Number(typeof item === 'object' && item !== null ? item.id : item);
    if (byId.has(id) && !seen.has(id)) {
      seen.add(id);
      matched.push(byId.get(id));
    }
  }
  return matched;
}

// The jack components of the given modules, labeled for the scoping prompt.
export async function jackComponentsForModules(db, moduleIds) {
  if (moduleIds.length === 0) return [];
  const { Module, ModuleComponent } = db.models;
  const components = await ModuleComponent.findAll({
    where: { module_id: moduleIds, type: ['input_jack', 'output_jack', 'bidirectional_jack'] },
    include: [{ model: Module, attributes: ['manufacturer', 'name'] }],
    order: [['id', 'ASC']],
  });
  return components.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    module_label: `${c.Module.manufacturer} ${c.Module.name}`.trim(),
  }));
}

// Phase one: figure out which of the user's modules (and which jacks) the
// question applies to, persist the links, and mark the question 'scoped' so
// the user can review the scope and pick attachments before it is answered.
// An empty scope is not an error — the user adds modules during review.
export async function scopeQuestion(db, backend, question, { log = () => {} } = {}) {
  const { Module, Question, QuestionModule, QuestionComponent } = db.models;
  // Every module across all of the user's racks, deduped.
  const ownedIds = await userModuleIds(db, question.user_id);
  if (ownedIds.length === 0) throw new Error('No modules imported yet');
  const records = await Module.findAll({
    where: { id: ownedIds },
    order: [
      ['manufacturer', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  const modules = records.map((m) => m.get({ plain: true }));

  const scoped = await determineScope(backend, question.prompt, modules);
  log(
    scoped.length > 0
      ? `in scope: ${scoped.map((m) => `${m.manufacturer} ${m.name}`).join(', ')}`
      : 'no modules auto-detected; select modules in the review step'
  );

  // The specific input/output jacks the question pertains to. Component
  // scoping is best-effort: a failure here must not block the review step.
  let scopedJacks = [];
  if (scoped.length > 0) {
    try {
      const jacks = await jackComponentsForModules(db, scoped.map((m) => m.id));
      scopedJacks = await determineComponentScope(backend, question.prompt, jacks);
      if (scopedJacks.length > 0) {
        log(
          `jacks in scope: ${scopedJacks.map((c) => `${c.module_label} ${c.name}`).join(', ')}`
        );
      }
    } catch (e) {
      log(`component scoping failed (continuing): ${e.message}`);
    }
  }

  await db.sequelize.transaction(async (transaction) => {
    await QuestionModule.destroy({ where: { question_id: question.id }, transaction });
    if (scoped.length > 0) {
      await QuestionModule.bulkCreate(
        scoped.map((m) => ({ question_id: question.id, module_id: m.id })),
        { transaction }
      );
    }
    await QuestionComponent.destroy({ where: { question_id: question.id }, transaction });
    if (scopedJacks.length > 0) {
      await QuestionComponent.bulkCreate(
        scopedJacks.map((c) => ({ question_id: question.id, component_id: c.id })),
        { transaction }
      );
    }
    await Question.update(
      { status: 'scoped', error: null },
      { where: { id: question.id }, transaction }
    );
  });
  return scoped;
}

// One line per normalled connection on the given modules, so the answer
// prompt can describe the default signal routing that exists without any
// patch cables (essential for tracing a patch's actual signal path).
export async function normalizationSummary({ ModuleComponent, ComponentNormalization }, modules) {
  if (modules.length === 0) return [];
  const normalizations = await ComponentNormalization.findAll({
    where: { module_id: modules.map((m) => m.id) },
    order: [['id', 'ASC']],
  });
  if (normalizations.length === 0) return [];
  const components = await ModuleComponent.findAll({
    where: { module_id: modules.map((m) => m.id) },
    attributes: ['id', 'name'],
  });
  const componentName = new Map(components.map((c) => [c.id, c.name]));
  const moduleLabel = new Map(
    modules.map((m) => [m.id, `${m.manufacturer} ${m.name}`.trim()])
  );
  return normalizations.map((n) => {
    const source = n.source_component_id
      ? `the "${componentName.get(n.source_component_id)}" ${n.kind === 'input' ? 'input (its patched signal)' : 'output'}`
      : `the internal signal "${n.source_label}"`;
    const target = `"${componentName.get(n.target_component_id)}"`;
    // A default that only holds in one position of a control, and one that a
    // cable somewhere else cancels, are both easy to state wrongly.
    const condition = n.condition_component_id
      ? `, but only while "${componentName.get(n.condition_component_id)}" is set to ${n.condition_value}`
      : '';
    const broken =
      n.break_component_id && n.break_component_id !== n.target_component_id
        ? ` (cancelled by a cable ${n.break_on === 'cable_out' ? 'out of' : 'into'} "${componentName.get(n.break_component_id)}", not by patching ${target})`
        : '';
    const detail = n.description ? ` — ${n.description}` : '';
    return `- ${moduleLabel.get(n.module_id)}: ${target} is normalled to ${source}${condition}${broken}${detail}`;
  });
}

// Phase two, after the user confirmed the review step: submit the question
// with exactly the linked modules and explicitly attached documents (manual
// PDFs, previous answers, notes) and store the answer.
export async function answerQuestion(db, backend, question, manualsDir, { log = () => {} } = {}) {
  const {
    Module,
    ModuleComponent,
    ComponentNormalization,
    Manual,
    Note,
    Question,
    QuestionModule,
    QuestionComponent,
    QuestionManual,
    QuestionAnswer,
    QuestionNote,
  } = db.models;

  const links = await QuestionModule.findAll({
    where: { question_id: question.id },
    include: Module,
    order: [
      [Module, 'manufacturer', 'ASC'],
      [Module, 'name', 'ASC'],
    ],
  });
  const scoped = links.map((l) => l.Module.get({ plain: true }));
  if (scoped.length === 0) {
    throw new Error('No modules are in scope for this question.');
  }
  log(`in scope: ${scoped.map((m) => `${m.manufacturer} ${m.name}`).join(', ')}`);

  // The specific components the question is tied to get called out in the
  // answer prompt.
  const componentLinks = await QuestionComponent.findAll({
    where: { question_id: question.id },
    include: [{ model: ModuleComponent, include: [Module] }],
    order: [['component_id', 'ASC']],
  });
  const components = componentLinks.map((l) => l.ModuleComponent).filter(Boolean);

  // The manual PDFs the user attached, deduped by content hash (some modules
  // share a manual file).
  const manualLinks = await QuestionManual.findAll({
    where: { question_id: question.id },
    include: Manual,
    order: [['manual_id', 'ASC']],
  });
  const hashes = [...new Set(manualLinks.map((l) => l.Manual.hash))].sort();
  const pdfPaths = [];
  for (const hash of hashes) {
    const pdf = manualPath(manualsDir, hash);
    const { ok, reason } = isProbablyPdf(pdf);
    if (ok) pdfPaths.push(pdf);
    else log(`skipping ${pdf}: ${reason}`);
  }

  // Attached previous answers and notes ride along as text documents.
  const answerLinks = await QuestionAnswer.findAll({
    where: { question_id: question.id },
    include: [{ model: Question, as: 'SourceQuestion' }],
    order: [['source_question_id', 'ASC']],
  });
  const previous = answerLinks
    .filter((l) => l.SourceQuestion?.answer)
    .map((l) => ({
      name: `previous-answer-${l.source_question_id}.md`,
      text: `# Question\n\n${l.SourceQuestion.prompt}\n\n# Answer\n\n${l.SourceQuestion.answer}`,
    }));

  const noteLinks = await QuestionNote.findAll({
    where: { question_id: question.id },
    include: Note,
    order: [['note_id', 'ASC']],
  });
  const notes = noteLinks
    .filter((l) => l.Note)
    .map((l) => ({
      name: `note-${l.note_id}.md`,
      text: l.Note.title ? `# ${l.Note.title}\n\n${l.Note.body}` : l.Note.body,
    }));

  const textDocs = [...previous, ...notes];
  if (pdfPaths.length === 0 && textDocs.length === 0) {
    throw new Error('No valid manual PDFs, previous answers, or notes are attached to this question.');
  }
  const manuals = pdfPaths.slice(0, MAX_MANUALS);

  const kinds = [];
  if (manuals.length > 0) kinds.push('module manuals');
  if (previous.length > 0) kinds.push('previous question-and-answer documents');
  if (notes.length > 0) kinds.push("the user's own notes");
  const moduleNames = scoped.map((m) => `${m.manufacturer} ${m.name}`).join(', ');
  let answerPrompt =
    `You are a eurorack modular synthesizer expert. Using the attached ${kinds.join(', ')} ` +
    `(for: ${moduleNames}), answer the following question. `;
  if (components.length > 0) {
    const componentNames = components
      .map((c) => `${c.Module.manufacturer} ${c.Module.name} — ${c.name} (${c.type})`.trim())
      .join('; ');
    answerPrompt += `The question specifically concerns these components: ${componentNames}. `;
  }
  const normalizationLines = await normalizationSummary(
    { ModuleComponent, ComponentNormalization },
    scoped
  );
  if (normalizationLines.length > 0) {
    answerPrompt +=
      `\n\nThe modules in scope have these normalled (default, unpatched) connections; ` +
      `account for them when tracing the signal path:\n${normalizationLines.join('\n')}\n\n`;
  }
  answerPrompt += `Format your answer as markdown.\n\nQuestion: ${question.prompt}`;

  const answer = await backend.answerWithDocuments(answerPrompt, manuals, textDocs);

  const [, updated] = await Question.update(
    { answer, status: 'answered', error: null, answered_at: new Date() },
    { where: { id: question.id }, returning: true }
  );
  return updated[0]?.get({ plain: true });
}
