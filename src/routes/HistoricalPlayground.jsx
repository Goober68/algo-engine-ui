// Native React playground — replaces the iframe. Schema-driven slider
// sidebar reading xovd_v1's playground_fields from coord, WS-driven
// rerun on slider change (debounced), stats strip + trades table.
//
// Equity curve and saved-configs panels are v2 — keeping v1 focused
// on the core loop (drag slider → see stats update) so the schema
// pipeline gets exercised end-to-end first.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchStrategySchema } from '../data/strategySchema';
import { getDefaults, getHello, getLastError, getSession, sendRun, start, stop, useWsStatus } from '../data/playgroundClient';

const STRATEGY = 'xovd_v1';
const RUN_DEBOUNCE_MS = 120;
const LS_AUTOSAVE = 'playground.autosave.v1';

export default function HistoricalPlayground() {
  const [schema, setSchema]       = useState(null);
  const [schemaErr, setSchemaErr] = useState(null);
  const [values, setValues]       = useState(null);    // current slider values, ordered per playground_fields
  const [stats, setStats]         = useState(null);
  const [trades, setTrades]       = useState([]);
  const [runWallMs, setRunWallMs] = useState(null);
  const [runError, setRunError]   = useState(null);
  const wsStatus = useWsStatus();
  const debounceRef = useRef(null);

  // Fetch schema on mount.
  useEffect(() => {
    let cancelled = false;
    fetchStrategySchema(STRATEGY)
      .then(s => {
        if (cancelled) return;
        setSchema(s);
        // Seed values from autosave-or-defaults.
        const order = (s.playground_fields?.fields) || [];
        const fromAutosave = readAutosave(order);
        const defaults = order.map(k => s.params[k]?.default ?? 0);
        setValues(fromAutosave || defaults);
      })
      .catch(e => { if (!cancelled) setSchemaErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Spawn a coord-mediated session on mount. If VITE_PLAYGROUND_DEFAULTS
  // is set the session starts with no further interaction; otherwise the
  // user has to wire up paths (Settings drawer is v2).
  useEffect(() => {
    if (getDefaults()) {
      start().catch(e => console.error('playground start failed:', e));
    }
    return () => { stop(); };
  }, []);

  // When the server sends its hello (with relay-mandated default_params),
  // adopt them if our seed differs (keeps slider order in sync with what
  // the relay expects positionally).
  useEffect(() => {
    if (!schema) return;
    const order = schema.playground_fields?.fields || [];
    const h = getHello();
    if (!h?.default_params || h.default_params.length !== order.length) return;
    // Only override on first connect if we have no autosave.
    if (readAutosave(order)) return;
    setValues(h.default_params.slice());
  }, [schema, wsStatus]);

  const onSliderChange = useCallback((idx, raw) => {
    if (!schema) return;
    const order = schema.playground_fields.fields;
    const def = schema.params[order[idx]];
    const v = (def.type === 'int') ? parseInt(raw, 10) : parseFloat(raw);
    setValues(prev => {
      const next = prev.slice();
      next[idx] = v;
      writeAutosave(next);
      return next;
    });
    // Debounced run-on-change.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(triggerRun, RUN_DEBOUNCE_MS);
  }, [schema]);

  const triggerRun = useCallback(async () => {
    if (!values) return;
    setRunError(null);
    const t0 = performance.now();
    try {
      const result = await sendRun(values);
      const elapsed = performance.now() - t0;
      setStats(result.stats || null);
      setTrades(Array.isArray(result.trades) ? result.trades : []);
      setRunWallMs(elapsed);
    } catch (e) {
      setRunError(e.message || String(e));
    }
  }, [values]);

  if (schemaErr) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-short">
        Failed to load schema: {schemaErr}
      </div>
    );
  }
  if (!schema || !values) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-muted">
        loading schema…
      </div>
    );
  }

  const order = schema.playground_fields?.fields || [];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Toolbar wsStatus={wsStatus} runWallMs={runWallMs} runError={runError} onRun={triggerRun} />
      <div className="flex-1 min-h-0 flex">
        <SliderPanel
          schema={schema}
          fields={order}
          values={values}
          onChange={onSliderChange}
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <StatsStrip stats={stats} />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <TradesTable trades={trades} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Toolbar (session status + manual Run button + last-run timing) ──
function Toolbar({ wsStatus, runWallMs, runError, onRun }) {
  const statusCls = wsStatus === 'ready'
    ? 'bg-long/20 text-long border-long/40'
    : wsStatus === 'connecting'
      ? 'bg-accent/20 text-accent border-accent/40'
      : 'bg-short/20 text-short border-short/40';
  const sess = getSession();
  const startErr = getLastError();
  return (
    <div className="bg-panel border-b border-border px-3 py-1 flex items-center gap-3 text-xs">
      <span className="font-semibold text-sm">XOVD Kernel Playground</span>
      <span className={`px-2 py-0.5 rounded text-[10px] border ${statusCls}`}>
        {wsStatus === 'ready' ? 'session ready' : wsStatus}
      </span>
      {sess && (
        <span className="text-muted text-[11px] tnum" title={`session ${sess.session_id}`}>
          {sess.runs_count} runs
        </span>
      )}
      <button
        onClick={onRun}
        disabled={wsStatus !== 'ready'}
        className="ml-auto px-3 py-0.5 rounded bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 disabled:opacity-30"
      >
        Run
      </button>
      {runWallMs != null && (
        <span className="text-muted text-[11px] tnum">last {runWallMs.toFixed(0)} ms</span>
      )}
      {(runError || (wsStatus === 'error' && startErr)) && (
        <span className="text-short text-[11px]" title={runError || startErr}>
          {wsStatus === 'error' ? 'session error' : 'run error'}
        </span>
      )}
    </div>
  );
}

// ── Slider sidebar — schema-driven ──────────────────────────────────
function SliderPanel({ schema, fields, values, onChange }) {
  return (
    <div className="w-[320px] min-h-0 overflow-y-auto border-r border-border bg-panel">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-muted border-b border-border">
        Parameters
      </div>
      {fields.map((key, i) => (
        <SliderRow key={key} def={schema.params[key]} fieldKey={key} value={values[i]}
                   onChange={(v) => onChange(i, v)} />
      ))}
    </div>
  );
}

function SliderRow({ def, fieldKey, value, onChange }) {
  if (!def) return null;
  const isInt   = def.type === 'int';
  const isFloat = def.type === 'float';
  // sweep_range is [start, step, stop]; use as slider min/step/max.
  const [min, step, max] = def.sweep_range || [
    isInt ? 0 : 0.0,
    isInt ? 1 : 0.01,
    isInt ? 100 : 1.0,
  ];
  // Risk-dollars is text in playground.html — same heuristic here:
  // text input for free-form numeric where dragging isn't meaningful.
  const useTextBox = fieldKey === 'riskDollars';
  // Use the field's `label` (from playground_fields[].label if added
  // later) or fall back to a key-as-label.
  const label = def.label || keyToLabel(fieldKey);
  const formatted = isInt ? value : Number(value).toFixed(stepPrecision(step));
  return (
    <div className="px-3 py-2 border-b border-border/40">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] text-muted truncate" title={def.tooltip || ''}>
          {label}
        </span>
        <span className="text-[12px] font-bold text-accent tnum">{formatted}</span>
      </div>
      {useTextBox ? (
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1 bg-bg border border-border rounded text-text text-[12px] tnum"
        />
      ) : (
        <>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full"
          />
          <div className="flex justify-between text-[9px] text-muted/60 tnum">
            <span>{min}</span>
            <span>{max}</span>
          </div>
        </>
      )}
    </div>
  );
}

function keyToLabel(k) {
  // tpAtrMult → "TP Atr Mult", tsTriggerTicks → "TS Trigger Ticks"
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}
function stepPrecision(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : (s.length - i - 1);
}

// ── Stats strip ─────────────────────────────────────────────────────
function StatsStrip({ stats }) {
  if (!stats) {
    return (
      <div className="bg-panel border-b border-border px-3 py-3 text-[11px] text-muted italic">
        Drag a slider (or click Run) to fire a kernel rerun.
      </div>
    );
  }
  // The new xovdV1Server schema uses string keys: trades/wins/losses/profit/wall_ms.
  // Legacy uses n_trades/n_wins/n_losses/total_pnl_points. Cover both.
  const n      = stats.trades      ?? stats.n_trades      ?? 0;
  const wins   = stats.wins        ?? stats.n_wins        ?? 0;
  const losses = stats.losses      ?? stats.n_losses      ?? 0;
  const wr     = n ? Math.round((wins / n) * 100) : 0;
  const profit = stats.profit      ?? stats.total_pnl_points ?? 0;
  const pf     = (losses === 0) ? '∞'
                 : (wins === 0) ? '0'
                 : ((wins * (profit > 0 ? profit / wins : 1)) /
                    Math.max(1, losses * (profit < 0 ? -profit / losses : 1))).toFixed(2);
  return (
    <div className="bg-panel border-b border-border px-3 py-2 flex items-center gap-6 tnum">
      <Cell label="trades" v={n} />
      <Cell label="wins"   v={wins}   cls="text-long" />
      <Cell label="losses" v={losses} cls="text-short" />
      <Cell label="WR"     v={`${wr}%`} cls={wrCls(wr)} />
      <Cell label="PF"     v={pf} />
      <Cell label="profit" v={fmtUSD(profit)} cls={profit >= 0 ? 'text-long' : 'text-short'} />
    </div>
  );
}
function Cell({ label, v, cls = '' }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-muted text-[10px] uppercase tracking-wide">{label}</span>
      <span className={`text-sm font-semibold ${cls}`}>{v}</span>
    </span>
  );
}
function wrCls(wr) { return wr >= 70 ? 'text-long' : wr >= 30 ? 'text-text' : 'text-short'; }
function fmtUSD(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(0);
}

// ── Trades table ────────────────────────────────────────────────────
function TradesTable({ trades }) {
  if (!trades?.length) {
    return <div className="px-3 py-4 text-xs text-muted italic">no trades</div>;
  }
  return (
    <table className="w-full text-xs tnum">
      <thead className="bg-panel sticky top-0">
        <tr className="text-muted text-[10px] uppercase tracking-wide">
          <th className="px-2 py-1 text-left">#</th>
          <th className="px-2 py-1 text-left">dir</th>
          <th className="px-2 py-1 text-right">size</th>
          <th className="px-2 py-1 text-right">entry</th>
          <th className="px-2 py-1 text-right">exit</th>
          <th className="px-2 py-1 text-right">px in</th>
          <th className="px-2 py-1 text-right">px out</th>
          <th className="px-2 py-1 text-left">reason</th>
          <th className="px-2 py-1 text-right">$</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t, i) => {
          const dir = t.dir || (t.direction === 1 ? 'LONG' : 'SHORT');
          const size = t.size ?? t.qty ?? 0;
          const eTs = t.entry_time ?? Math.floor((t.entry_ns ?? 0) / 1e9);
          const xTs = t.exit_time ?? Math.floor((t.exit_ns ?? 0) / 1e9);
          const eP = t.entry_price ?? t.entry_px ?? 0;
          const xP = t.exit_price ?? t.exit_px ?? 0;
          const reason = t.exit_reason ?? t.reason ?? '';
          const pnl = t.profit ?? t.profit_points ?? 0;
          const dirCls = dir.toUpperCase().startsWith('L') ? 'text-long' : 'text-short';
          const pnlCls = pnl >= 0 ? 'text-long' : 'text-short';
          return (
            <tr key={i} className="border-b border-border/40 hover:bg-accent/5">
              <td className="px-2 py-0.5">{i + 1}</td>
              <td className={`px-2 py-0.5 ${dirCls}`}>{dir.slice(0, 1)}</td>
              <td className="px-2 py-0.5 text-right">{size}</td>
              <td className="px-2 py-0.5 text-right text-muted">{fmtT(eTs)}</td>
              <td className="px-2 py-0.5 text-right text-muted">{fmtT(xTs)}</td>
              <td className="px-2 py-0.5 text-right">{Number(eP).toFixed(2)}</td>
              <td className="px-2 py-0.5 text-right">{Number(xP).toFixed(2)}</td>
              <td className="px-2 py-0.5 text-muted">{String(reason).toLowerCase()}</td>
              <td className={`px-2 py-0.5 text-right ${pnlCls}`}>{fmtUSD(pnl)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
function fmtT(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Autosave (slider values, localStorage) ─────────────────────────
function readAutosave(order) {
  try {
    const raw = window.localStorage.getItem(LS_AUTOSAVE);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== order.length) return null;
    return arr;
  } catch { return null; }
}
function writeAutosave(values) {
  try { window.localStorage.setItem(LS_AUTOSAVE, JSON.stringify(values)); } catch {}
}
