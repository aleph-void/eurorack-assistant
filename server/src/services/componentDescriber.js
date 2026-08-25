// Fill in facts the analysis never wrote — and nothing else.
//
// A component added by hand on the module page has a name and a type but no
// description, because no analysis ever read the manual with that component
// in mind; a module built by hand may also be missing its summary or width.
// Rather than re-run the whole analysis — which costs a full model pass and
// destroys hand corrections — this asks one narrow question about exactly
// the blank fields, and writes back nothing but them. A description, summary
// or HP that already exists is never touched, whatever the model answers.

import { extractJsonObject } from './json.js';
import { normalizeHp } from './panelPlacements.js';

export const DESCRIBE_TEMPLATE = (
  manufacturer,
  name,
  components,
  { summary = false, hp = false } = {}
) => {
  const lines = [
    `The attached document(s) describe the Eurorack module "${manufacturer} ${name}".`,
    '',
  ];
  if (components.length > 0) {
    lines.push(
      'The following controls and connection points of this module are known by name',
      'but have no description yet:',
      '',
      ...components.map((c) => `- "${c.name}" (${c.type.replace(/_/g, ' ')})`),
      '',
      'For each one the documents actually describe, write one or two sentences',
      "saying what it does, in the manual's own terms. Skip any the documents say",
      'nothing about — do not guess.'
    );
  }
  if (summary) {
    lines.push(
      '',
      'Also write a one- or two-sentence summary of what the module is and does.'
    );
  }
  if (hp) {
    lines.push(
      '',
      "Also state how wide the module's front panel is in HP (1HP = 5.08mm), but",
      'only if the documents state a width.'
    );
  }
  lines.push(
    '',
    'Respond with a JSON object of the shape:',
    '{"summary": "<summary>", "hp": <width>,',
    ' "components": [{"name": "<exactly as listed above>", "description": "<what it does>"}]}',
    'Include only what the documents support; omit anything they do not state.',
    'Respond with JSON only.'
  );
  return lines.join('\n');
};

// The components of a module whose description is missing or blank.
export async function undescribedComponents(db, moduleId) {
  const rows = await db.models.ModuleComponent.findAll({
    where: { module_id: moduleId },
    order: [['id', 'ASC']],
  });
  return rows.filter((c) => !String(c.description ?? '').trim());
}

// The blanks this pass may fill for a module: components with no
// description, a missing summary, a missing HP width, and a menu nobody has
// read yet.
//
// The menu is its own model pass (services/moduleParameters.js) rather than
// part of the description prompt — it asks a different question and answers
// with rows rather than sentences — but it is the same KIND of gap, so it is
// filled from the same job and reported here. 'pending' is what makes it a
// gap: a module whose documents have been read and hold no menu is complete,
// and asking again every sweep would cost a model run per module forever.
// A menu with parameters already in it is no gap either, whatever the status
// says — entered by hand, or by an earlier run the status never caught up
// with — because a blank is what this pass fills and that menu is not one.
// Re-reading a menu that has entries is the module page's own button, which
// queues find_parameters directly and never asks what is missing.
export async function moduleFactGaps(db, module) {
  const record = await db.models.Module.findByPk(module.id);
  const recorded = await db.models.ModuleParameter.count({
    where: { module_id: module.id },
  });
  return {
    components: await undescribedComponents(db, module.id),
    summary: !String(record?.summary ?? '').trim(),
    hp: record?.hp == null,
    parameters: recorded === 0 && (record?.parameters_status ?? 'pending') === 'pending',
  };
}

// Ask the backend about the module's blank facts and store what it found.
// Returns { asked, described, summary, hp }; asked === 0 with neither flag
// set means there was nothing to do and no model was run.
export async function describeComponentsForModule(db, backend, module, manualPaths) {
  const gaps = await moduleFactGaps(db, module);
  const nothing = { asked: 0, described: 0, summary: false, hp: false };
  if (gaps.components.length === 0 && !gaps.summary && !gaps.hp) return nothing;

  const paths = Array.isArray(manualPaths) ? manualPaths : [manualPaths];
  const prompt = DESCRIBE_TEMPLATE(module.manufacturer, module.name, gaps.components, {
    summary: gaps.summary,
    hp: gaps.hp,
  });
  const response =
    paths.length > 1
      ? await backend.analyzeDocuments(prompt, paths)
      : await backend.analyzeDocument(prompt, paths[0]);
  const parsed = extractJsonObject(response);
  const answers = Array.isArray(parsed.components) ? parsed.components : [];
  const byName = new Map();
  for (const raw of answers) {
    const name = String(raw?.name || '').trim().toLowerCase();
    const description = String(raw?.description || '').trim();
    if (name && description) byName.set(name, description.slice(0, 2000));
  }

  let described = 0;
  for (const component of gaps.components) {
    const description = byName.get(component.name.trim().toLowerCase());
    if (!description) continue;
    await component.update({ description });
    described += 1;
  }

  // The summary and the width are only ever filled into a blank — re-read at
  // write time, so an analysis that finished while the model was thinking is
  // not overwritten either.
  const updates = {};
  const summary = String(parsed.summary || '').trim();
  const hp = normalizeHp(parsed.hp);
  const current = await db.models.Module.findByPk(module.id);
  if (gaps.summary && summary && !String(current?.summary ?? '').trim()) {
    updates.summary = summary;
  }
  if (gaps.hp && hp !== null && current?.hp == null) updates.hp = hp;
  if (Object.keys(updates).length > 0) {
    await db.models.Module.update(updates, { where: { id: module.id } });
  }
  return {
    asked: gaps.components.length,
    described,
    summary: Boolean(updates.summary),
    hp: updates.hp !== undefined,
  };
}
