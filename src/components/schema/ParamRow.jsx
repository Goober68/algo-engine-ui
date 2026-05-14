// Compact one-line param row for the playground. Single horizontal
// strip: [label] [control flex-1] [value]. Mirrors SweepRow's density
// while keeping playground's slider-driven editing (sweep tab uses
// number inputs in fixed mode; playground keeps continuous sliders
// because the live-rerun loop is the whole point of the tab).
//
// Layout per row:
//   label   ~108px   (truncates with hover-tooltip on full label/key)
//   control flex-1   (slider / chips / toggle / text input)
//   value   ~44px    (right-aligned current value, accent-coloured)

import { camelToLabel, paramHoverTitle } from './schemaLabels';

const NUMERIC = new Set(['int', 'float']);
const ENUM_CHIP_THRESHOLD = 8;

export default function ParamRow({ schemaField, value, onChange, disabled = false }) {
  if (!schemaField) return null;
  const def = schemaField;
  const label = def.label || camelToLabel(def.name);
  // Value column is redundant when the control already displays the
  // value (enum chips show the active option; bool toggle shows on/off
  // by position). Hide for those — the slider/number-input row keeps
  // the readout because slider position alone is imprecise.
  const showValueCol = !(def.type === 'enum' || def.type === 'bool');
  return (
    <div className="px-2 py-px border-b border-border/20 hover:bg-accent/[0.03]">
      <div className="flex items-center gap-1.5">
        <span
          className="text-[11px] text-text truncate w-[108px] shrink-0"
          title={paramHoverTitle(def)}
        >
          {label}
        </span>
        <div className="flex-1 min-w-0">
          <Control def={def} value={value} onChange={onChange} disabled={disabled} />
        </div>
        {showValueCol && (
          <span className="text-[11px] font-bold text-accent tnum w-[44px] text-right shrink-0">
            {formatValue(def, value)}
          </span>
        )}
      </div>
    </div>
  );
}

function Control({ def, value, onChange, disabled }) {
  // Some keys are free-text rather than slider (drag isn't useful for
  // them — risk dollars, max contracts, etc).
  const useText = def.text_input
    || (NUMERIC.has(def.type) && def.sweep_range == null)
    || (def.name === 'riskDollars');

  if (def.type === 'bool') {
    return <BoolToggle value={value} onChange={onChange} disabled={disabled} />;
  }
  if (def.type === 'enum') {
    return <EnumChips def={def} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (NUMERIC.has(def.type) && useText) {
    return <NumberInput def={def} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (NUMERIC.has(def.type)) {
    return <SliderInline def={def} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (def.type === 'string') {
    return <TextInput value={value} onChange={onChange} disabled={disabled} />;
  }
  return <span className="text-[10px] text-muted">unknown type {String(def.type)}</span>;
}

// Single inline range slider — no min/max labels (those leak to the
// hover tooltip via title attr). Tight vertical track keeps each row
// at ~16px instead of the old ~36px stacked layout.
function SliderInline({ def, value, onChange, disabled }) {
  const [min, step, max] = def.sweep_range || [0, def.type === 'int' ? 1 : 0.01, 100];
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      title={`${min} … ${max}`}
      onChange={(e) => onChange(coerce(def, e.target.value))}
      className="w-full block"
    />
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
      className="w-full px-2 py-0 bg-bg border border-border rounded text-text text-[11px] tnum h-5 disabled:opacity-40"
    />
  );
}

// iOS-style pill: green = on, grey = off, white thumb slides. The
// prior accent-blue pip-on-stripe felt cramped; this reads as a real
// switch.
function BoolToggle({ value, onChange, disabled }) {
  const on = !!value;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      title={on ? 'on' : 'off'}
      className={
        'relative w-9 h-5 rounded-full border transition-colors ' +
        (on ? 'bg-long border-long' : 'bg-panel border-border') +
        ' disabled:opacity-40 disabled:cursor-not-allowed'
      }
    >
      <span
        className={
          'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-text shadow-sm transition-transform ' +
          (on ? 'translate-x-[18px]' : 'translate-x-0.5')
        }
      />
    </button>
  );
}

// Radio chips when option count fits one inline row; dropdown otherwise.
function EnumChips({ def, value, onChange, disabled }) {
  const options = Array.isArray(def.values) ? def.values : [];
  if (options.length > ENUM_CHIP_THRESHOLD) {
    return (
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-1 py-0 bg-bg border border-border rounded text-text text-[11px] h-5 disabled:opacity-40"
      >
        {options.map(o => (
          <option key={String(o)} value={String(o)}>{String(o)}</option>
        ))}
      </select>
    );
  }
  const current = String(value ?? def.default);
  return (
    <div className="flex gap-0.5">
      {options.map(o => {
        const v = String(o);
        const on = v === current;
        return (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => onChange(v)}
            className={
              'px-1.5 py-0 rounded border text-[10px] h-5 disabled:opacity-40 ' +
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

function TextInput({ value, onChange, disabled }) {
  return (
    <input
      type="text"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-0 bg-bg border border-border rounded text-text text-[11px] h-5 disabled:opacity-40"
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
