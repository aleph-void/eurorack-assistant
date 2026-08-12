// Question answering, ported from eurorack-processor's ask.py: determine which
// of the user's modules are in scope, gather their manual PDFs and previous
// answers, submit everything to the LLM backend, and store the linked answer.

import path from 'node:path';
import { extractJsonArray } from './json.js';
import { isProbablyPdf } from './pdf.js';

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
  const placeholders = moduleIds.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `SELECT mc.id, mc.name, mc.type, m.manufacturer, m.name AS module_name
     FROM module_components mc
     JOIN modules m ON m.id = mc.module_id
     WHERE mc.module_id IN (${placeholders}) AND mc.type IN ('input_jack', 'output_jack')
     ORDER BY mc.id`,
    moduleIds
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    module_label: `${r.manufacturer} ${r.module_name}`.trim(),
  }));
}

// Previous answered questions of this user that involve any in-scope module,
// passed along as extra context documents (ask.py's find_markdown_docs).
export async function findPreviousAnswers(db, userId, scopedModuleIds) {
  if (scopedModuleIds.length === 0) return [];
  const placeholders = scopedModuleIds.map((_, i) => `$${i + 2}`).join(', ');
  const { rows } = await db.query(
    `SELECT DISTINCT q.id, q.prompt, q.answer, q.created_at
     FROM questions q
     JOIN question_modules qm ON qm.question_id = q.id
     WHERE q.user_id = $1 AND q.status = 'answered' AND q.answer IS NOT NULL
       AND qm.module_id IN (${placeholders})
     ORDER BY q.created_at ASC`,
    [userId, ...scopedModuleIds]
  );
  return rows.map((r) => ({
    name: `previous-answer-${r.id}.md`,
    text: `# Question\n\n${r.prompt}\n\n# Answer\n\n${r.answer}`,
  }));
}

// Full pipeline for one question. Returns the updated question row.
export async function answerQuestion(db, backend, question, manualsDir, { log = () => {} } = {}) {
  const { rows: modules } = await db.query(
    `SELECT m.* FROM user_modules um JOIN modules m ON m.id = um.module_id
     WHERE um.user_id = $1 ORDER BY m.manufacturer, m.name`,
    [question.user_id]
  );
  if (modules.length === 0) throw new Error('No modules imported yet');

  const scoped = await determineScope(backend, question.prompt, modules);
  if (scoped.length === 0) {
    throw new Error('No modules were determined to be in scope for this question.');
  }
  log(`in scope: ${scoped.map((m) => `${m.manufacturer} ${m.name}`).join(', ')}`);

  for (const m of scoped) {
    const { rows: linked } = await db.query(
      'SELECT 1 FROM question_modules WHERE question_id = $1 AND module_id = $2',
      [question.id, m.id]
    );
    if (linked.length === 0) {
      await db.query(
        'INSERT INTO question_modules (question_id, module_id) VALUES ($1, $2)',
        [question.id, m.id]
      );
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
      const { rows: linked } = await db.query(
        'SELECT 1 FROM question_components WHERE question_id = $1 AND component_id = $2',
        [question.id, jack.id]
      );
      if (linked.length === 0) {
        await db.query(
          'INSERT INTO question_components (question_id, component_id) VALUES ($1, $2)',
          [question.id, jack.id]
        );
      }
    }
  } catch (e) {
    log(`component scoping failed (continuing): ${e.message}`);
  }

  // Collect manual PDFs for the in-scope modules: the shared auto-found
  // manuals plus documents this user attached to their own module instances.
  // Deduped by filename (some modules share a manual file).
  const modulePlaceholders = scoped.map((_, i) => `$${i + 2}`).join(', ');
  const { rows: manualRows } = await db.query(
    `SELECT DISTINCT filename FROM manuals
     WHERE module_id IN (${modulePlaceholders}) AND (user_id IS NULL OR user_id = $1)
     ORDER BY filename`,
    [question.user_id, ...scoped.map((m) => m.id)]
  );
  const pdfPaths = [];
  for (const row of manualRows) {
    const pdf = path.join(manualsDir, row.filename);
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

  const { rows } = await db.query(
    `UPDATE questions SET answer = $2, status = 'answered', error = NULL, answered_at = now()
     WHERE id = $1 RETURNING *`,
    [question.id, answer]
  );
  return rows[0];
}
