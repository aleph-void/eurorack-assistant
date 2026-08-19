// JSON shapes for a module's shared hardware facts. Every /api/modules route
// that returns a component, value, normalization, route, switch or pair goes
// through these, so the same entity serializes the same way on every endpoint.

export const componentJson = (c, extra = {}) => ({
  id: c.id,
  type: c.type,
  name: c.name,
  description: c.description,
  voltage_min: c.voltage_min,
  voltage_max: c.voltage_max,
  polarity: c.polarity,
  group_label: c.group_label,
  port_kind: c.port_kind,
  ...extra,
});

export const valueJson = (row) => ({
  id: row.id,
  component_id: row.component_id,
  type: row.type,
  value: row.value,
  description: row.description,
});

export const normalizationJson = (n) => ({
  id: n.id,
  target_component_id: n.target_component_id,
  source_component_id: n.source_component_id,
  source_label: n.source_label,
  kind: n.kind,
  condition_component_id: n.condition_component_id,
  condition_value: n.condition_value,
  alt_group: n.alt_group,
  break_component_id: n.break_component_id,
  break_on: n.break_on,
  description: n.description,
});

export const routeJson = (r) => ({
  id: r.id,
  input_component_id: r.input_component_id,
  output_component_id: r.output_component_id,
  condition_component_id: r.condition_component_id,
  condition_value: r.condition_value,
  alt_group: r.alt_group,
  description: r.description,
});

export const switchJson = (s, stepComponentIds) => ({
  id: s.id,
  name: s.name,
  common_component_id: s.common_component_id,
  step_component_ids: stepComponentIds,
  description: s.description,
});

export const pairJson = (p) => ({
  id: p.id,
  a_component_id: p.a_component_id,
  b_component_id: p.b_component_id,
  kind: p.kind,
  description: p.description,
});
