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
