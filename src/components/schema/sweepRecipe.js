// Sweep-recipe data model + math helpers. A "recipe" is a map of
// param_name → per-row state. The route-level component owns this
// state; SweepRow reads + onChange-mutates one entry at a time.
//
// Per-row shape:
//   numeric:  { swept: bool, fixed: number, start: number, step: number, stop: number }
//   enum:     { swept: bool, fixed: string, values: [string, ...] }
//   bool:     { swept: bool, fixed: bool,   values: [bool, ...]  }
//   string:   {                fixed: string                     }
//
// Recipe submitted to coord (when /api/sweeps lands) is the sub-shape
// that excludes UI-only fields. Each row exports one of:
//   { fixed: <value> }                   — non-swept row
//   { sweep: { start, step, stop } }     — numeric range
//   { sweep: { values: [...] } }         — enum / bool list
// See toSubmitPayload() for the conversion.

// Build the initial recipe from a schema. All sweepable=true params
// start swept with their schema sweep_range as defaults; non-sweepable
// start fixed at their default.
export function initialRecipe(schema) {
  const out = {};
  for (const [name, def] of Object.entries(schema?.params || {})) {
    out[name] = initialRow(def);
  }
  return out;
}

function initialRow(def) {
  if (def.type === 'int' || def.type === 'float') {
    const [start, step, stop] = def.sweep_range || [
      def.default ?? 0,
      def.type === 'int' ? 1 : 0.01,
      def.default ?? 0,
    ];
    return {
      swept: false,
      fixed: def.default ?? 0,
      start, step, stop,
    };
  }
  if (def.type === 'enum') {
    return {
      swept: false,
      fixed: def.default ?? def.values?.[0] ?? '',
      values: [def.default ?? def.values?.[0]].filter(v => v != null),
    };
  }
  if (def.type === 'bool') {
    return {
      swept: false,        // default to fixed for bools — sweeping bool is always intentional
      fixed: !!def.default,
      values: [false, true],
    };
  }
  return { fixed: def.default ?? '' };
}

// Per-row config-count contribution. Always returns >= 1 (a row that
// resolves to no values would zero the cartesian product, which the
// UI surfaces as an error).
export function configCountForRow(def, recipe) {
  if (!recipe) return 1;
  if (def.type === 'bool') {
    if (recipe.swept) return Math.max(1, (recipe.values || []).length);
    return 1;
  }
  if (def.type === 'enum') {
    if (recipe.swept) return Math.max(1, (recipe.values || []).length);
    return 1;
  }
  if (def.type === 'int' || def.type === 'float') {
    if (!recipe.swept) return 1;
    const start = num(recipe.start), step = num(recipe.step), stop = num(recipe.stop);
    if (!Number.isFinite(start) || !Number.isFinite(step) || !Number.isFinite(stop)) return 1;
    if (step <= 0) return 1;
    if (stop < start) return 1;
    return Math.floor((stop - start) / step + 1e-9) + 1;
  }
  return 1;
}

// Section's contribution to total = product of its rows' contributions.
export function configCountForSection(schema, section, recipeMap) {
  let count = 1;
  for (const row of (section.rows || [])) {
    for (const col of (row.cols || [])) {
      const def = schema.params[col.key];
      if (!def) continue;
      count *= configCountForRow(def, recipeMap[col.key]);
    }
  }
  return count;
}

// Total cartesian product over the whole recipe.
export function totalConfigs(schema, recipeMap) {
  let count = 1;
  for (const [name, def] of Object.entries(schema?.params || {})) {
    count *= configCountForRow(def, recipeMap[name]);
  }
  return count;
}

// Convert UI recipe → submission payload (the shape coord expects).
export function toSubmitPayload(strategy, schema, recipeMap) {
  const recipe = {};
  for (const [name, def] of Object.entries(schema?.params || {})) {
    const r = recipeMap[name];
    if (!r) continue;
    if (def.type === 'bool') {
      recipe[name] = r.swept
        ? { sweep: { values: r.values || [false, true] } }
        : { fixed: !!r.fixed };
      continue;
    }
    if (def.type === 'enum') {
      recipe[name] = r.swept
        ? { sweep: { values: r.values || [def.default] } }
        : { fixed: r.fixed ?? def.default };
      continue;
    }
    if (def.type === 'int' || def.type === 'float') {
      recipe[name] = r.swept
        ? { sweep: { start: num(r.start), step: num(r.step), stop: num(r.stop) } }
        : { fixed: num(r.fixed) };
      continue;
    }
    if (def.type === 'string') {
      recipe[name] = { fixed: r.fixed ?? def.default ?? '' };
    }
  }
  return { strategy, recipe };
}

function num(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
