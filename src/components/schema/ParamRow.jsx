// Compact one-line-ish param row used by the playground and (later)
// the sweep recipe builder. Renders an int/float as a slider, a bool
// as a toggle, an enum as a dropdown, a string as a text input. The
// label sits left, the current value right; the input occupies the
// row below at full width (sliders) or inline (text/enum/bool).
//
// Dense by design: padding tuned so ~30 fields fit a 320px sidebar
// without scrolling pain.

const NUMERIC = new Set(['int', 'float']);

export default function ParamRow({ schemaField, value, onChange, disabled = false }) {
  if (!schemaField) return null;
  const def = schemaField;

  return (
    <div className="px-3 py-1 border-b border-border/20 hover:bg-accent/[0.03]">
      <div className="flex items-baseline justify-between mb-0.5">
        <span
          className="text-[11px] text-muted truncate"
          title={def.tooltip || def.name || ''}
        >
          {def.label || def.name}
        </span>
        <span className="text-[12px] font-bold text-accent tnum">
          {formatValue(def, value)}
        </span>
      </div>
      <Control def={def} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function Control({ def, value, onChange, disabled }) {
  // Some keys we want as a free-text number rather than a slider
  // (drag isn't useful for them — risk dollars, max contracts, etc).
  // Heuristic for the playground; sweep UI overrides explicitly.
  const useText = def.text_input
    || (NUMERIC.has(def.type) && def.sweep_range == null)
    || (def.name === 'riskDollars');

  if (def.type === 'bool') {
    return <BoolToggle value={value} onChange={onChange} disabled={disabled} />;
  }
  if (def.type === 'enum') {
    return <EnumSelect def={def} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (NUMERIC.has(def.type) && useText) {
    return <NumberInput def={def} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (NUMERIC.has(def.type)) {
    return <SliderRow def={def} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (def.type === 'string') {
    return <TextInput value={value} onChange={onChange} disabled={disabled} />;
  }
  return <span className="text-[10px] text-muted">unknown type {String(def.type)}</span>;
}

function SliderRow({ def, value, onChange, disabled }) {
  const [min, step, max] = def.sweep_range || [0, def.type === 'int' ? 1 : 0.01, 100];
  return (
    <div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(coerce(def, e.target.value))}
      />
      <div className="flex justify-between text-[9px] text-muted/60 tnum -mt-0.5">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function NumberInput({ def, value, onChange, disabled }) {
  const [min, step, max] = def.sweep_range || [
    -Infinity, def.type === 'int' ? 1 : 0.01, Infinity,
  ];
  return (
    <input
      type="number"
      value={value}
      min={Number.isFinite(min) ? min : undefined}
      max={Number.isFinite(max) ? max : undefined}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(coerce(def, e.target.value))}
      className="w-full px-2 py-0.5 bg-bg border border-border rounded text-text text-[12px] tnum disabled:opacity-40"
    />
  );
}

function BoolToggle({ value, onChange, disabled }) {
  const on = !!value;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className={
        'relative w-9 h-4 rounded-full border transition-colors ' +
        (on ? 'bg-accent/40 border-accent/60' : 'bg-bg border-border') +
        ' disabled:opacity-40 disabled:cursor-not-allowed'
      }
    >
      <span
        className={
          'absolute top-0 w-4 h-4 rounded-full transition-transform border ' +
          (on ? 'translate-x-5 bg-accent border-accent' : 'translate-x-0 bg-muted border-border')
        }
      />
    </button>
  );
}

function EnumSelect({ def, value, onChange, disabled }) {
  const options = Array.isArray(def.values) ? def.values : [];
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-0.5 bg-bg border border-border rounded text-text text-[12px] disabled:opacity-40"
    >
      {options.map(o => (
        <option key={String(o)} value={String(o)}>{String(o)}</option>
      ))}
    </select>
  );
}

function TextInput({ value, onChange, disabled }) {
  return (
    <input
      type="text"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-0.5 bg-bg border border-border rounded text-text text-[12px] disabled:opacity-40"
    />
  );
}

// ── helpers ─────────────────────────────────────────────────────────
function coerce(def, raw) {
  if (def.type === 'int')   return parseInt(raw, 10);
  if (def.type === 'float') return parseFloat(raw);
  return raw;
}
function formatValue(def, v) {
  if (v == null) return '—';
  if (def.type === 'int') return v;
  if (def.type === 'float') {
    const step = def.sweep_range?.[1] ?? 0.01;
    const dp = stepPrecision(step);
    return Number(v).toFixed(dp);
  }
  if (def.type === 'bool') return v ? 'on' : 'off';
  return String(v);
}
function stepPrecision(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : (s.length - i - 1);
}
