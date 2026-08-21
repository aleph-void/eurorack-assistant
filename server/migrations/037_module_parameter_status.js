// Reading a module's menu is a step of the pipeline, so it needs the two
// things every other step has: somewhere to say it has been done, and a name
// on each parameter that survives the analysis rebuilding the panel it hangs
// off.
//
// WITHOUT A STATUS, "this module has no menu parameters" and "nobody has ever
// looked" are the same state — and most modules have no menu at all, so the
// fill-the-blanks sweep would ask a model about every one of them, every time
// it ran, forever. `parameters_status` closes the gap the way manual_status,
// analysis_status and panel_status close theirs.
//
// WITHOUT THE NAME, a re-analysis silently eats the menu: it destroys and
// recreates every module_components row, and module_parameters.component_id
// cascades with them. The name is what the analysis rebinds each parameter by
// once the new rows have their ids.

export const description = 'menu parameter status per module, and the component name each parameter hangs off';

export async function up({ sql }) {
  await sql`
ALTER TABLE modules ADD COLUMN parameters_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE module_parameters ADD COLUMN component_name TEXT;
`;
  // A module that already has parameters has plainly had its menu read.
  // component_name is left blank here rather than backfilled: the routes and
  // the extraction both write it from now on, the rebinding fills it in for
  // anything older the next time an analysis runs, and a correlated UPDATE
  // is one of the things pg-mem cannot run in the tests.
  await sql`
UPDATE modules
   SET parameters_status = 'complete'
 WHERE id IN (SELECT module_id FROM module_parameters)
`;
}

export async function down({ dropColumn }) {
  await dropColumn('module_parameters', 'component_name');
  await dropColumn('modules', 'parameters_status');
}
