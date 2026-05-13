// Native React playground — replaces the iframe. Schema-driven slider
// sidebar reading xovd_v1's playground_fields from coord, WS-driven
// rerun on slider change (debounced), stats strip + equity curve +
// trades table. Saved-configs panel still pending.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchStrategySchema } from '../data/strategySchema';
import { getDefaults, getHello, getLastError, getSession, sendRun, start, stop, useWsStatus } from '../data/playgroundClient';
import SchemaSection from '../components/schema/SchemaSection';
import ParamRow from '../components/schema/ParamRow';

const STRATEGY = 'xovd_v1';
const RUN_DEBOUNCE_MS = 120;
const LS_AUTOSAVE = 'playground.autosave.v1';

export default function LabPlayground() {
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
          <EquityCurve trades={trades} />
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

// ── Slider sidebar — schema-driven, grouped by schema.sections ──────
// Renders one SchemaSection per section that contains at least one
// field present in `fields` (the playground_fields whitelist). Inside
// each section, rows are kept in the schema's row/col order so the
// layout matches what the future config editor / sweep UI will show.
function SliderPanel({ schema, fields, values, onChange }) {
  const sections = useMemo(
    () => groupFieldsBySection(schema, fields),
    [schema, fields]
  );
  // Index lookup so onChange can map field-name → its slot in `values`.
  const idxOf = useMemo(() => {
    const m = new Map();
    fields.forEach((k, i) => m.set(k, i));
    return m;
  }, [fields]);

  return (
    <div className="w-[300px] min-h-0 overflow-y-auto border-r border-border bg-panel">
      {sections.map(s => (
        <SchemaSection
          key={s.id}
          id={`playground.${s.id}`}
          title={s.title}
          badge={`${s.fields.length}`}
          defaultOpen={true}
        >
          {s.fields.map(key => (
            <ParamRow
              key={key}
              schemaField={{ ...schema.params[key], name: key }}
              value={values[idxOf.get(key)]}
              onChange={(v) => onChange(idxOf.get(key), v)}
            />
          ))}
        </SchemaSection>
      ))}
    </div>
  );
}

// Bucket each `fields` entry into the section it appears in (per
// schema.sections[].rows[].cols[]). Fields not found in any section
// fall into a synthetic "Other" group at the end. Sections are
// returned in schema.sections order; sweep_weight isn't used in the
// playground, but the sweep UI will sort by it.
function groupFieldsBySection(schema, fields) {
  const fieldSet = new Set(fields);
  const sectionOf = new Map();      // field key → section id
  const sectionTitle = new Map();   // section id → title
  for (const sec of (schema?.sections || [])) {
    sectionTitle.set(sec.id, sec.title);
    for (const row of (sec.rows || [])) {
      for (const col of (row.cols || [])) {
        if (col.key) sectionOf.set(col.key, sec.id);
      }
    }
  }
  // Preserve playground_fields order within each section.
  const buckets = new Map();
  for (const key of fields) {
    const sid = sectionOf.get(key) || '_other';
    if (!buckets.has(sid)) buckets.set(sid, []);
    buckets.get(sid).push(key);
  }
  // Emit in schema-section order (so the visual order matches what
  // engine-claude defined in the JSON), with "_other" last.
  const out = [];
  for (const sec of (schema?.sections || [])) {
    if (buckets.has(sec.id)) {
      out.push({ id: sec.id, title: sec.title, fields: buckets.get(sec.id) });
    }
  }
  if (buckets.has('_other')) {
    out.push({ id: '_other', title: 'Other', fields: buckets.get('_other') });
  }
  return out;
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
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toFixed(0);
}

// ── Equity curve (cumulative $ over trade index) ────────────────────
// Restored from the legacy strategy-visualizer/playground.html canvas.
// One point per trade; line color tracks final-PnL sign. Tracks the
// peak so a drawdown shading is trivial to add later.
function EquityCurve({ trades }) {
  const series = useMemo(() => {
    if (!trades?.length) return null;
    let cum = 0, peak = 0, maxDD = 0;
    const pts = trades.map((t, i) => {
      const p = t.profit ?? t.profit_points ?? 0;
      cum += Number(p) || 0;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
      return { i, cum };
    });
    const lo = Math.min(0, ...pts.map(p => p.cum));
    const hi = Math.max(0, ...pts.map(p => p.cum));
    return { pts, lo, hi, final: cum, peak, maxDD };
  }, [trades]);

  if (!series) {
    return (
      <div className="bg-panel border-b border-border px-3 py-2 text-[10px] text-muted/70 italic">
        Equity curve — run a sweep / drag a slider to populate.
      </div>
    );
  }

  // Inline SVG. Width auto-fits container; height fixed.
  const W = 800, H = 90, PAD = 4;
  const { pts, lo, hi, final, peak, maxDD } = series;
  const span = (hi - lo) || 1;
  const xOf = (i) => PAD + (i / Math.max(1, pts.length - 1)) * (W - 2 * PAD);
  const yOf = (v) => H - PAD - ((v - lo) / span) * (H - 2 * PAD);
  const zeroY = yOf(0);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.i).toFixed(1)},${yOf(p.cum).toFixed(1)}`).join(' ');
  const stroke = final >= 0 ? '#26a69a' : '#ef5350';   // long / short

  return (
    <div className="bg-panel border-b border-border px-3 py-1">
      <div className="flex items-baseline gap-4 text-[10px]">
        <span className="text-muted uppercase tracking-wide">equity</span>
        <span className={'tnum font-semibold ' + (final >= 0 ? 'text-long' : 'text-short')}>
          {fmtUSD(final)}
        </span>
        <span className="text-muted tnum">peak <span className="text-text">{fmtUSD(peak)}</span></span>
        <span className="text-muted tnum">max DD <span className="text-short">{fmtUSD(-maxDD)}</span></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height: H }}>
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY}
              stroke="#2a2e36" strokeWidth="1" strokeDasharray="2 3" />
        <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" />
      </svg>
    </div>
  );
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
