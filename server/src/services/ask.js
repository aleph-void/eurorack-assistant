// Question answering, ported from eurorack-processor's ask.py: determine which
// of the user's modules are in scope, gather their manual PDFs and previous
// answers, submit everything to the LLM backend, and store the linked answer.

import { Op } from 'sequelize';
import { extractJsonArray } from './json.js';
import { isProbablyPdf, manualPath } from './pdf.js';

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
    where: { module_id: moduleIds, type: ['input_jack', 'output_jack'] },
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

// Previous answered questions of this user that involve any in-scope module,
// passed along as extra context documents (ask.py's find_markdown_docs).
export async function findPreviousAnswers(db, userId, scopedModuleIds) {
  if (scopedModuleIds.length === 0) return [];
  const { Question, QuestionModule } = db.models;
  // Eager loading dedupes questions linked to several in-scope modules.
  const questions = await Question.findAll({
    where: { user_id: userId, status: 'answered', answer: { [Op.not]: null } },
    include: [
      { model: QuestionModule, attributes: ['module_id'], where: { module_id: scopedModuleIds } },
    ],
    order: [['created_at', 'ASC']],
  });
  return questions.map((q) => ({
    name: `previous-answer-${q.id}.md`,
    text: `# Question\n\n${q.prompt}\n\n# Answer\n\n${q.answer}`,
  }));
}

// Full pipeline for one question. Returns the updated question row.
export async function answerQuestion(db, backend, question, manualsDir, { log = () => {} } = {}) {
  const { Module, UserModule, Manual, Question, QuestionModule, QuestionComponent } = db.models;
  const mappings = await UserModule.findAll({
    where: { user_id: question.user_id },
    include: Module,
    order: [
      [Module, 'manufacturer', 'ASC'],
      [Module, 'name', 'ASC'],
    ],
  });
  const modules = mappings.map((um) => um.Module.get({ plain: true }));
  if (modules.length === 0) throw new Error('No modules imported yet');

  const scoped = await determineScope(backend, question.prompt, modules);
  if (scoped.length === 0) {
    throw new Error('No modules were determined to be in scope for this question.');
  }
  log(`in scope: ${scoped.map((m) => `${m.manufacturer} ${m.name}`).join(', ')}`);

  for (const m of scoped) {
    const linked = await QuestionModule.findOne({
      where: { question_id: question.id, module_id: m.id },
    });
    if (!linked) {
      await QuestionModule.create({ question_id: question.id, module_id: m.id });
    }
  }

  // Link the specific input/output jacks the question pertains to. Component
  // scoping is best-effort: a failure here must not block the answer.
  try {
    const jacks = await jackComponentsForModules(db, scoped.map((m) => m.id));
    const scopedJacks = await determineComponentScope(backend, question.prompt, jacks);
    if (scopedJacks.length > 0) {
      log(
        `jacks in scope: ${scopedJacks.map((c) => `${c.module_label} ${c.name}`).join(', ')}`
      );
    }
    for (const jack of scopedJacks) {
      const linked = await QuestionComponent.findOne({
        where: { question_id: question.id, component_id: jack.id },
      });
      if (!linked) {
        await QuestionComponent.create({ question_id: question.id, component_id: jack.id });
      }
    }
  } catch (e) {
    log(`component scoping failed (continuing): ${e.message}`);
  }

  // Collect manual PDFs for the in-scope modules: the shared auto-found
  // manuals plus documents this user attached to their own module instances.
  // Deduped by content hash (some modules share a manual file).
  const manualRows = await Manual.findAll({
    where: {
      module_id: scoped.map((m) => m.id),
      [Op.or]: [{ user_id: null }, { user_id: question.user_id }],
    },
    attributes: ['hash'],
  });
  const hashes = [...new Set(manualRows.map((r) => r.hash))].sort();
  const pdfPaths = [];
  for (const hash of hashes) {
    const pdf = manualPath(manualsDir, hash);
    const { ok, reason } = isProbablyPdf(pdf);
    if (ok) pdfPaths.push(pdf);
    else log(`skipping ${pdf}: ${reason}`);
  }

  const previous = await findPreviousAnswers(db, question.user_id, scoped.map((m) => m.id));
  if (pdfPaths.length === 0 && previous.length === 0) {
    throw new Error('No valid manual PDFs or previous answers found for the in-scope modules.');
  }
  const manuals = pdfPaths.slice(0, MAX_MANUALS);

  const moduleNames = scoped.map((m) => `${m.manufacturer} ${m.name}`).join(', ');
  const attachments =
    previous.length === 0
      ? 'module manuals'
      : 'module manuals and previous question-and-answer documents';
  const answerPrompt =
    `You are a eurorack modular synthesizer expert. Using the attached ${attachments} ` +
    `(for: ${moduleNames}), answer the following question. ` +
    `Format your answer as markdown.\n\nQuestion: ${question.prompt}`;

  const answer = await backend.answerWithDocuments(answerPrompt, manuals, previous);

  const [, updated] = await Question.update(
    { answer, status: 'answered', error: null, answered_at: new Date() },
    { where: { id: question.id }, returning: true }
  );
  return updated[0]?.get({ plain: true });
}
