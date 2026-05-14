// Tiny shared helper used by SweepRow + ParamRow to derive a display
// label from a camelCase kernel param name when the schema doesn't
// ship a hand-authored `label` field. Best-effort; engine-claude's
// hand-authored labels (when present) take precedence.

export function camelToLabel(name) {
  if (!name) return '';
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^[a-z]/, c => c.toUpperCase());
}

// Combine the kernel param name + optional tooltip into a single
// hover string. Kernel name is the technical handle (grep-friendly);
// tooltip is the human description. Always show name; show tooltip
// below it when present.
export function paramHoverTitle(def) {
  if (!def?.name) return '';
  return def.tooltip ? `${def.name}\n\n${def.tooltip}` : def.name;
}

// Evaluate a schema's depends_on predicate against the current values
// dict. Three shapes accepted:
//   undefined           -> always active
//   "<key>"             -> active when values[key] is truthy (legacy)
//   { k1: v1, k2: [...] } -> active when EVERY key matches (string-eq);
//                          arrays accept any-of
// Engine schema lands the object form for mode-gated rows; legacy
// string form stays compatible.
export function paramActive(def, values) {
  const dep = def?.depends_on;
  if (!dep) return true;
  if (!values) return true;
  if (typeof dep === 'string') return !!values[dep];
  if (typeof dep === 'object') {
    for (const [k, req] of Object.entries(dep)) {
      const cur = values[k];
      if (Array.isArray(req)) {
        if (!req.some(r => String(r) === String(cur))) return false;
      } else if (typeof req === 'boolean') {
        if (Boolean(cur) !== req) return false;
      } else {
        if (String(cur) !== String(req)) return false;
      }
    }
    return true;
  }
  return true;
}
