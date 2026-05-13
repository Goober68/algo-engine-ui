// Sweep-recipe row. Different per type:
//   int/float  → "fixed | sweep" toggle + (start, step, stop) boxes
//   enum       → "fixed | sweep" toggle + multi-select chips per value
//   bool       → 3-state radio (false / true / both)
//   string     → fixed text input only (strings aren't swept)
// Plus a sweepable-checkbox; non-sweepable schema params render
// disabled in fixed-only mode with a "schema: not sweepable" hint.
//
// Per-row config-count is shown in the right gutter so users see
// each row's contribution to the cartesian total at a glance.

import { configCountForRow } from './sweepRecipe';

export default function SweepRow({ schemaField, recipe, onChange }) {
  const def = schemaField;
  if (!def) return null;
  const sweepableInSchema = def.sweepable === true;
  const isSwept = recipe.swept && sweepableInSchema;
  const count = configCountForRow(def, recipe);

  return (
    <div className="px-3 py-1 border-b border-border/20 hover:bg-accent/[0.03]">
      <div className="flex items-baseline justify-between gap-2 mb-0.5">
        <span className="text-[11px] text-muted truncate" title={def.tooltip || def.name}>
          {def.label || def.name}
          {!sweepableInSchema && (
            <span className="ml-1 text-[9px] text-muted/60">(fixed only)</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className={'text-[10px] tnum ' +
                           (count > 1 ? 'text-accent' : 'text-muted/60')}>
            {count}×
          </span>
          {sweepableInSchema && (
            <button
              type="button"
              role="switch"
              aria-checked={isSwept}
              onClick={() => onChange({ ...recipe, swept: !isSwept })}
              className={
                'relative w-7 h-3.5 rounded-full border transition-colors ' +
                (isSwept ? 'bg-accent/40 border-accent/60' : 'bg-bg border-border')
              }
              title={isSwept ? 'sweep this param' : 'fix this param'}
            >
              <span
                className={
                  'absolute top-0 w-3.5 h-3.5 rounded-full transition-transform border ' +
                  (isSwept
                    ? 'translate-x-3.5 bg-accent border-accent'
                    : 'translate-x-0 bg-muted border-border')
                }
              />
            </button>
          )}
        </span>
      </div>
      <Control def={def} recipe={recipe} isSwept={isSwept} onChange={onChange} />
    </div>
  );
}

function Control({ def, recipe, isSwept, onChange }) {
  if (def.type === 'bool')   return <BoolTriState recipe={recipe} isSwept={isSwept} onChange={onChange} />;
  if (def.type === 'enum')   return <EnumSweep    def={def} recipe={recipe} isSwept={isSwept} onChange={onChange} />;
  if (def.type === 'int' || def.type === 'float') {
    return isSwept
      ? <NumericRange def={def} recipe={recipe} onChange={onChange} />
      : <NumericFixed def={def} recipe={recipe} onChange={onChange} />;
  }
  if (def.type === 'string') return <TextFixed recipe={recipe} onChange={onChange} />;
  return <span className="text-[10px] text-muted">unknown type {String(def.type)}</span>;
}

// ── Numeric: fixed value ────────────────────────────────────────────
function NumericFixed({ def, recipe, onChange }) {
  return (
    <input
      type="number"
      value={recipe.fixed ?? def.default ?? 0}
      step={def.sweep_range?.[1] ?? (def.type === 'int' ? 1 : 0.01)}
      onChange={(e) => onChange({ ...recipe, fixed: coerce(def, e.target.value) })}
      className="w-full px-2 py-0.5 bg-bg border border-border rounded text-text text-[11px] tnum"
    />
  );
}

// ── Numeric: range (start/step/stop) ────────────────────────────────
function NumericRange({ def, recipe, onChange }) {
  const set = (k, v) => onChange({ ...recipe, [k]: coerce(def, v) });
  return (
    <div className="grid grid-cols-3 gap-1 text-[10px]">
      <RangeBox label="start" value={recipe.start} step={def.sweep_range?.[1]} type={def.type} onChange={(v) => set('start', v)} />
      <RangeBox label="step"  value={recipe.step}  step={def.sweep_range?.[1]} type={def.type} onChange={(v) => set('step',  v)} />
      <RangeBox label="stop"  value={recipe.stop}  step={def.sweep_range?.[1]} type={def.type} onChange={(v) => set('stop',  v)} />
    </div>
  );
}
function RangeBox({ label, value, step, type, onChange }) {
  return (
    <label className="flex flex-col">
      <span className="text-muted/60 text-[9px] uppercase tracking-wide">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        step={step ?? (type === 'int' ? 1 : 0.01)}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-1 py-0.5 bg-bg border border-border rounded text-text text-[11px] tnum"
      />
    </label>
  );
}

// ── Enum: fixed value vs multi-select sweep ─────────────────────────
function EnumSweep({ def, recipe, isSwept, onChange }) {
  const options = Array.isArray(def.values) ? def.values : [];
  if (!isSwept) {
    return (
      <select
        value={recipe.fixed ?? def.default}
        onChange={(e) => onChange({ ...recipe, fixed: e.target.value })}
        className="w-full px-2 py-0.5 bg-bg border border-border rounded text-text text-[11px]"
      >
        {options.map(o => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </select>
    );
  }
  const selected = new Set(recipe.values || [def.default]);
  const toggle = (v) => {
    const s = new Set(selected);
    if (s.has(v)) s.delete(v); else s.add(v);
    onChange({ ...recipe, values: [...s] });
  };
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(o => {
        const v = String(o);
        const on = selected.has(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => toggle(v)}
            className={
              'px-1.5 py-0.5 rounded border text-[10px] ' +
              (on
                ? 'bg-accent/20 text-accent border-accent/60'
                : 'bg-bg text-muted border-border hover:border-muted')
            }
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

// ── Bool: 3-state (false / true / both) ─────────────────────────────
function BoolTriState({ recipe, isSwept, onChange }) {
  const v = isSwept
    ? (recipe.values?.length === 2 ? 'both' : (recipe.values?.[0] === true ? 'true' : 'false'))
    : (recipe.fixed ? 'true' : 'false');
  const set = (mode) => {
    if (mode === 'both')  onChange({ ...recipe, swept: true,  values: [false, true] });
    if (mode === 'true')  onChange({ ...recipe, swept: false, fixed: true });
    if (mode === 'false') onChange({ ...recipe, swept: false, fixed: false });
  };
  const Btn = ({ mode, label }) => (
    <button
      type="button"
      onClick={() => set(mode)}
      className={
        'px-1.5 py-0.5 rounded border text-[10px] flex-1 ' +
        (v === mode
          ? 'bg-accent/20 text-accent border-accent/60'
          : 'bg-bg text-muted border-border hover:border-muted')
      }
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-1">
      <Btn mode="false" label="false" />
      <Btn mode="true"  label="true"  />
      <Btn mode="both"  label="both"  />
    </div>
  );
}

// ── String fixed (strings aren't swept) ─────────────────────────────
function TextFixed({ recipe, onChange }) {
  return (
    <input
      type="text"
      value={recipe.fixed ?? ''}
      onChange={(e) => onChange({ ...recipe, fixed: e.target.value })}
      className="w-full px-2 py-0.5 bg-bg border border-border rounded text-text text-[11px]"
    />
  );
}

// ── Coerce a raw input string to the field's numeric type ──────────
function coerce(def, raw) {
  if (def.type === 'int')   return parseInt(raw, 10);
  if (def.type === 'float') return parseFloat(raw);
  return raw;
}
