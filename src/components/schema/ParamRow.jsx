// Compact one-line-ish param row used by the playground. Renders an
// int/float as a slider, bool as a toggle, enum as chip buttons
// (radio), string as a text input. Mirrors SweepRow's label/hover
// polish so the two layouts feel like siblings.
//
// Two-row layout: [label + value] / [control full-width below].
// Sliders need horizontal real estate so the value-on-top + slider-
// below pattern is denser than inlining the slider with the label.

import { camelToLabel, paramHoverTitle } from './schemaLabels';

const NUMERIC = new Set(['int', 'float']);
const ENUM_CHIP_THRESHOLD = 8;

export default function ParamRow({ schemaField, value, onChange, disabled = false }) {
  if (!schemaField) return null;
  const def = schemaField;
  const label = def.label || camelToLabel(def.name);

  return (
    <div className="px-3 py-px border-b border-border/20 hover:bg-accent/[0.03]">
      <div className="flex items-baseline justify-between mb-px">
        <span
          className="text-[11px] text-text truncate"
          title={paramHoverTitle(def)}
        >
          {label}
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
    return <EnumChips def={def} value={value} onChange={onChange} disabled={disabled} />;
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

// Radio-style chip picker. Falls back to a dropdown when there are
// too many options to fit on a single line of chips.
function EnumChips({ def, value, onChange, disabled }) {
  const options = Array.isArray(def.values) ? def.values : [];
  if (options.length > ENUM_CHIP_THRESHOLD) {
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
  const current = String(value ?? def.default);
  return (
    <div className="flex flex-wrap gap-1">
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
              'px-1.5 py-0.5 rounded border text-[10px] disabled:opacity-40 ' +
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
