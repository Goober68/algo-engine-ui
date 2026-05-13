// Sweep-recipe row, redesigned per Niall 2026-05-13:
//   [label] [SWEEP|FIXED toggle adjacent]  [<inline control>]  [N×]
// when swept (numeric):
//   [start ●━━━━━━━━━━━━━●  stop]   [step ●━━━━━━ N]
//
// Sweep/fixed toggle sits next to the label so users see at a glance
// what's swept; range slider has dual thumbs for [start, stop]; a
// second single-thumb slider sets the step. Per-row config-count
// stays in the rightmost gutter. Bottom-right of the route also
// surfaces total dimensionality so it stays visible when the toolbar
// scrolls out.

import { configCountForRow } from './sweepRecipe';

export default function SweepRow({ schemaField, recipe, onChange }) {
  const def = schemaField;
  if (!def) return null;
  const sweepableInSchema = def.sweepable === true;
  const isSwept = recipe.swept && sweepableInSchema;
  const count = configCountForRow(def, recipe);

  return (
    <div className="px-3 py-1 border-b border-border/20 hover:bg-accent/[0.03]">
      <div className="flex items-center gap-2">
        <Header def={def} isSwept={isSwept} sweepableInSchema={sweepableInSchema}
                onToggle={() => onChange({ ...recipe, swept: !isSwept })} />
        <div className="flex-1 min-w-0">
          <Control def={def} recipe={recipe} isSwept={isSwept} onChange={onChange} />
        </div>
        <CountBadge count={count} />
      </div>
    </div>
  );
}

// ── Label + adjacent SWEEP/FIXED pill ────────────────────────────────
function Header({ def, isSwept, sweepableInSchema, onToggle }) {
  return (
    <div className="flex items-center gap-1.5 min-w-[170px] max-w-[220px]">
      <span className="text-[11px] text-text truncate" title={def.tooltip || def.name}>
        {def.label || def.name}
      </span>
      {sweepableInSchema ? (
        <button
          type="button"
          onClick={onToggle}
          className={
            'text-[8px] px-1.5 py-px rounded uppercase tracking-wider font-bold transition-colors ' +
            (isSwept
              ? 'bg-accent/30 text-accent border border-accent/60'
              : 'bg-bg text-muted border border-border hover:text-text hover:border-muted')
          }
          title={isSwept ? 'sweep -> click to fix' : 'fixed -> click to sweep'}
        >
          {isSwept ? 'sweep' : 'fixed'}
        </button>
      ) : (
        <span className="text-[8px] text-muted/40 uppercase tracking-wider">no-sweep</span>
      )}
    </div>
  );
}

// ── Right-most per-row config-count ─────────────────────────────────
function CountBadge({ count }) {
  return (
    <span className={'text-[10px] tnum w-10 text-right shrink-0 ' +
                     (count > 1 ? 'text-accent font-semibold' : 'text-muted/60')}>
      {count}×
    </span>
  );
}

// ── Type dispatch ───────────────────────────────────────────────────
function Control({ def, recipe, isSwept, onChange }) {
  if (def.type === 'bool')   return <BoolTriState recipe={recipe} isSwept={isSwept} onChange={onChange} />;
  if (def.type === 'enum')   return <EnumSweep    def={def} recipe={recipe} isSwept={isSwept} onChange={onChange} />;
  if (def.type === 'int' || def.type === 'float') {
    return isSwept
      ? <NumericRangeSlider def={def} recipe={recipe} onChange={onChange} />
      : <NumericFixed def={def} recipe={recipe} onChange={onChange} />;
  }
  if (def.type === 'string') return <TextFixed recipe={recipe} onChange={onChange} />;
  return <span className="text-[10px] text-muted">unknown type {String(def.type)}</span>;
}

// ── Numeric: fixed value (single inline number input) ──────────────
function NumericFixed({ def, recipe, onChange }) {
  return (
    <input
      type="number"
      value={recipe.fixed ?? def.default ?? 0}
      step={def.sweep_range?.[1] ?? (def.type === 'int' ? 1 : 0.01)}
      onChange={(e) => onChange({ ...recipe, fixed: coerce(def, e.target.value) })}
      className="w-24 px-2 py-0.5 bg-bg border border-border rounded text-text text-[11px] tnum"
    />
  );
}

// ── Numeric: dual-thumb range + step slider ─────────────────────────
function NumericRangeSlider({ def, recipe, onChange }) {
  const sr = def.sweep_range || [0, 1, 100];
  const [schemaMin, schemaStepDefault, schemaMax] = sr;

  // Step slider bounds: from one schema-step up to half the span (so
  // even at max-step you still get >= 3 sample points).
  const isInt = def.type === 'int';
  const span = schemaMax - schemaMin;
  const minStep = isInt ? 1 : (schemaStepDefault ?? span / 100);
  const maxStep = Math.max(minStep, span / 2);
  const stepGran = isInt ? 1 : (schemaStepDefault ?? span / 200);

  const set = (patch) => onChange({ ...recipe, ...patch });

  return (
    <div className="flex items-center gap-3 min-w-0">
      {/* Range area gets 2x the flex grow of the step area so the
          dual-thumb slider — the more dimensionally informative one —
          stays the visual anchor as the form column resizes. */}
      <div className="flex items-center gap-2 min-w-0" style={{ flex: '2 1 0%' }}>
        <span className="text-[10px] text-muted tnum w-12 text-right shrink-0">{fmt(recipe.start, isInt)}</span>
        <DualRangeSlider
          min={schemaMin}
          max={schemaMax}
          step={isInt ? 1 : (schemaStepDefault ?? span / 200)}
          valueA={Number(recipe.start)}
          valueB={Number(recipe.stop)}
          onChange={(a, b) => set({ start: isInt ? Math.round(a) : a, stop: isInt ? Math.round(b) : b })}
        />
        <span className="text-[10px] text-muted tnum w-12 text-left shrink-0">{fmt(recipe.stop, isInt)}</span>
      </div>
      <div className="flex items-center gap-1 min-w-0" style={{ flex: '1 1 0%' }}>
        <span className="text-[9px] text-muted/60 uppercase tracking-wide w-7 shrink-0">step</span>
        <input
          type="range"
          min={minStep}
          max={maxStep}
          step={stepGran}
          value={Number(recipe.step) || minStep}
          onChange={(e) => set({ step: isInt ? Math.round(+e.target.value) : +e.target.value })}
          className="flex-1 min-w-0"
        />
        <span className="text-[10px] text-muted tnum w-10 text-right shrink-0">{fmt(recipe.step, isInt)}</span>
      </div>
    </div>
  );
}

// Dual-thumb range slider built from two overlapping <input type=range>.
// CSS in styles.css makes the input track invisible + non-interactive
// while keeping the thumb pseudo grabbable.
function DualRangeSlider({ min, max, step, valueA, valueB, onChange }) {
  const span = max - min || 1;
  const pctA = ((valueA - min) / span) * 100;
  const pctB = ((valueB - min) / span) * 100;
  return (
    <div className="relative h-4 flex-1 min-w-0">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-panel border border-border rounded" />
      <div className="absolute top-1/2 -translate-y-1/2 h-1 bg-accent/60 rounded"
           style={{ left: `${Math.max(0, Math.min(100, pctA))}%`,
                    right: `${Math.max(0, Math.min(100, 100 - pctB))}%` }} />
      <input
        type="range" min={min} max={max} step={step}
        value={valueA}
        onChange={(e) => {
          const v = +e.target.value;
          onChange(Math.min(v, valueB), valueB);
        }}
        className="dual-range absolute inset-0 w-full"
      />
      <input
        type="range" min={min} max={max} step={step}
        value={valueB}
        onChange={(e) => {
          const v = +e.target.value;
          onChange(valueA, Math.max(v, valueA));
        }}
        className="dual-range absolute inset-0 w-full"
      />
    </div>
  );
}

// ── Enum: fixed value vs multi-select sweep (unchanged from prior pass) ──
function EnumSweep({ def, recipe, isSwept, onChange }) {
  const options = Array.isArray(def.values) ? def.values : [];
  if (!isSwept) {
    return (
      <select
        value={recipe.fixed ?? def.default}
        onChange={(e) => onChange({ ...recipe, fixed: e.target.value })}
        className="w-32 px-2 py-0.5 bg-bg border border-border rounded text-text text-[11px]"
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
        'px-2 py-0.5 rounded border text-[10px] ' +
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
      className="w-48 px-2 py-0.5 bg-bg border border-border rounded text-text text-[11px]"
    />
  );
}

// ── helpers ─────────────────────────────────────────────────────────
function coerce(def, raw) {
  if (def.type === 'int')   return parseInt(raw, 10);
  if (def.type === 'float') return parseFloat(raw);
  return raw;
}

function fmt(v, isInt) {
  if (v == null || v === '') return '-';
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  if (isInt) return String(Math.round(n));
  // Float: trim trailing zeros for compactness.
  return Number(n.toFixed(4)).toString();
}
