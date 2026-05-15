// Compact (symbol, from, to, period_sec) picker for the playground +
// sweep toolbars. Submits the recipe over the wire as part of the
// playground session-create body or sweep submit body; coord/main.py
// resolve_dataset_paths() materializes via the stitcher (cache-hit
// returns instantly; miss takes ~24s for 4yr at 33M rec/s, less for
// shorter ranges).
//
// Replaces the data-window chip's "build then activate" UX -- there's
// no more "build" step, the stitcher handles materialization on
// demand and caches by recipe hash.

import { useEffect, useState } from 'react';

// Picker symbols. Coord routes these to the right shard family:
//   "MNQ"   -> continuous-front-month (MNQ.c.0), 4yr+ history
//   "MNQM6" -> explicit June 2026 contract, recent days only
// Lift to a coord endpoint if symbology grows.
const SYMBOLS = ['MNQ', 'MNQM6'];

const PERIODS = [
  { sec: 60,   label: 'M1' },
  { sec: 180,  label: 'M3' },
  { sec: 300,  label: 'M5' },
  { sec: 900,  label: 'M15' },
  { sec: 3600, label: 'H1' },
];

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export const DEFAULT_RANGE = {
  symbol:     'MNQ',                // continuous front-month (4yr history)
  frm:        isoDaysAgo(30),
  to:         isoDaysAgo(1),
  period_sec: 180,
};

// `value` = {symbol, frm, to, period_sec}; `onChange` fires with the
// merged next value. `dirty` shows the apply button + dim warning when
// the parent's "applied" range hasn't caught up yet.
export default function DateRangePicker({ value, onChange, dirty, onApply, applyLabel = 'Apply' }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] tnum">
      <span className="text-muted text-[10px] uppercase tracking-wide">data</span>
      <select
        value={value.symbol}
        onChange={e => onChange({ ...value, symbol: e.target.value })}
        className="bg-bg border border-border rounded px-1 py-0.5 text-text"
      >
        {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <input
        type="date"
        value={value.frm}
        onChange={e => onChange({ ...value, frm: e.target.value })}
        className="bg-bg border border-border rounded px-1 py-0.5 text-text"
      />
      <span className="text-muted">→</span>
      <input
        type="date"
        value={value.to}
        onChange={e => onChange({ ...value, to: e.target.value })}
        className="bg-bg border border-border rounded px-1 py-0.5 text-text"
      />
      <select
        value={value.period_sec}
        onChange={e => onChange({ ...value, period_sec: parseInt(e.target.value, 10) })}
        className="bg-bg border border-border rounded px-1 py-0.5 text-text"
        title="bar period (M3 is canonical XOVD)"
      >
        {PERIODS.map(p => <option key={p.sec} value={p.sec}>{p.label}</option>)}
      </select>
      {onApply && (
        <button
          onClick={onApply}
          disabled={!dirty}
          className={'px-2 py-0.5 rounded border ' + (dirty
            ? 'bg-accent/20 text-accent border-accent/40 hover:bg-accent/30'
            : 'border-border text-muted opacity-40')}
          title={dirty ? 'apply range (re-stitches if needed)' : 'no pending change'}
        >
          {applyLabel}
        </button>
      )}
    </div>
  );
}

// Persist the picker's state across page reloads. localStorage-backed,
// scoped by feature key ('playground' / 'sweep') so the two tabs can
// keep independent ranges.
const LS_KEY = (scope) => `algoengine.dateRange.v1.${scope}`;

export function usePersistedRange(scope, fallback = DEFAULT_RANGE) {
  const [v, setV] = useState(() => {
    try {
      const raw = window.localStorage.getItem(LS_KEY(scope));
      if (raw) return { ...fallback, ...JSON.parse(raw) };
    } catch {}
    return fallback;
  });
  useEffect(() => {
    try { window.localStorage.setItem(LS_KEY(scope), JSON.stringify(v)); } catch {}
  }, [scope, v]);
  return [v, setV];
}
