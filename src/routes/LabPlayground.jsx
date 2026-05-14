// Native React playground — replaces the iframe. Schema-driven slider
// sidebar reading xovd_v1's playground_fields from coord, WS-driven
// rerun on slider change (debounced), stats strip + equity curve +
// trades table. Saved-configs panel still pending.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchStrategySchema } from '../data/strategySchema';
import { fetchSessionBars, getDefaults, getLastError, getSession, sendRun, start, stop, useWsStatus } from '../data/playgroundClient';
import { expandDecisions } from '../data/decisionsCodec';
import SchemaSection from '../components/schema/SchemaSection';
import ParamRow from '../components/schema/ParamRow';
import SavedConfigs from '../components/schema/SavedConfigs';
import { paramActive } from '../components/schema/schemaLabels';
import ChartPane from '../components/slot/ChartPane';
import Splitter from '../components/chrome/Splitter';
import { usePersistedSize } from '../components/chrome/usePersistedSize';

const STRATEGY = 'xovd_v1';
const RUN_DEBOUNCE_MS = 120;
// Bumped to v2 when the values shape switched from positional array
// to {key: value} dict (engine 19db867 unblock). Old v1 entries are
// ignored on first read and replaced on next write.
const LS_AUTOSAVE = 'playground.autosave.v2';

export default function LabPlayground() {
  const [schema, setSchema]       = useState(null);
  const [schemaErr, setSchemaErr] = useState(null);
  const [values, setValues]       = useState(null);    // current slider values, ordered per playground_fields
  const [stats, setStats]         = useState(null);
  const [trades, setTrades]       = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [runWallMs, setRunWallMs] = useState(null);
  const [runInFlight, setRunInFlight] = useState(false);
  const [selectedTradeKey, setSelectedTradeKey] = useState(null);   // entry_ts in ns; clicked-trade sync between equity panel + chart
  const [sliderWidth, setSliderWidth] = usePersistedSize('lab.playground.sliderWidth', 300);
  const [runError, setRunError]   = useState(null);
  const [chartBars, setChartBars] = useState(null);    // {ts_ns, open, high, low, close, ...}[]
  const [tf, setTf]               = useState(180);     // M3 default
  const wsStatus = useWsStatus();
  const debounceRef = useRef(null);

  // Fetch schema on mount.
  useEffect(() => {
    let cancelled = false;
    fetchStrategySchema(STRATEGY)
      .then(s => {
        if (cancelled) return;
        setSchema(s);
        // Seed values dict from autosave-or-defaults. Engine 19db867's
        // JSON-keyed RUN means the wire format isn't capped at 12
        // positional fields; we now hold every sweepable param as a
        // {key: value} pair and send the whole dict on each RUN.
        const sweepable = sweepableKeys(s);
        const fromAutosave = readAutosave();
        const defaults = Object.fromEntries(
          sweepable.map(k => [k, s.params[k]?.default ?? 0])
        );
        setValues(fromAutosave
          ? { ...defaults, ...fromAutosave }    // autosave overlays defaults
          : defaults);
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

  // Once the session is ready, fetch the dataset's bars for the chart.
  // Bars don't change between RUNs so this is a one-shot per session.
  // When the session has --indicators, coord merges fast_ma/slow_ma/atr
  // straight into each bar so the MA overlays just work.
  useEffect(() => {
    if (wsStatus !== 'ready') return;
    let cancelled = false;
    fetchSessionBars()
      .then(d => {
        if (cancelled) return;
        const bars = (d.bars || []).map((b, i) => ({
          ts_ns:   b.time * 1e9,
          bar_idx: i,
          open:    b.open, high: b.high, low: b.low, close: b.close,
          volume:  b.volume,
          fast_ma: b.fast_ma ?? 0,
          slow_ma: b.slow_ma ?? 0,
          atr:     b.atr     ?? 0,
        }));
        setChartBars(bars);
      })
      .catch(e => console.error('playground bars fetch failed:', e));
    return () => { cancelled = true; };
  }, [wsStatus]);

  // valuesRef keeps triggerRun stateless on values: the debounced
  // setTimeout fires the LATEST sliders, not whatever was captured at
  // useCallback time (the closure-bug that made slider drags re-run
  // with the seed dict and look like nothing was changing).
  const valuesRef = useRef(values);
  useEffect(() => { valuesRef.current = values; }, [values]);

  const triggerRun = useCallback(async () => {
    const v = valuesRef.current;
    if (!v) return;
    setRunError(null);
    setRunInFlight(true);
    const t0 = performance.now();
    try {
      // JSON-keyed RUN: send the whole values dict; engine merges over
      // the .set baseline. Empty dict = pure baseline.
      const result = await sendRun(v);
      const elapsed = performance.now() - t0;
      setStats(result.stats || null);
      setTrades(Array.isArray(result.trades) ? result.trades : []);
      setDecisions(expandDecisions(result.decisions));
      setRunWallMs(elapsed);
    } catch (e) {
      setRunError(e.message || String(e));
    } finally {
      setRunInFlight(false);
    }
  }, []);

  const onSliderChange = useCallback((key, raw) => {
    if (!schema) return;
    const def = schema.params[key];
    if (!def) return;
    const v = (def.type === 'int') ? parseInt(raw, 10)
            : (def.type === 'float') ? parseFloat(raw)
            : raw;
    setValues(prev => {
      const next = { ...prev, [key]: v };
      writeAutosave(next);
      return next;
    });
    // Debounced run-on-change. triggerRun reads valuesRef so it sees
    // the just-written value even though setValues is async.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(triggerRun, RUN_DEBOUNCE_MS);
  }, [schema, triggerRun]);

  // Hoist before the early returns -- React needs the same hook order
  // every render (the schema-loading guard would otherwise skip it on
  // first render and trigger "Rendered more hooks" once schema arrives).
  const tradeStats = useMemo(() => computeTradeStats(trades, STARTING_BAL), [trades]);

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

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Toolbar wsStatus={wsStatus} runWallMs={runWallMs} runError={runError} onRun={triggerRun} />
      <div className="flex-1 min-h-0 flex">
        <SliderPanel
          schema={schema}
          values={values}
          onChange={onSliderChange}
          width={sliderWidth}
          onLoadConfig={(cfg) => {
            const next = { ...values, ...(cfg.values || {}) };
            setValues(next);
            writeAutosave(next);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(triggerRun, RUN_DEBOUNCE_MS);
          }}
          onReset={() => {
            const defaults = Object.fromEntries(
              sweepableKeys(schema).map(k => [k, schema.params[k]?.default ?? 0])
            );
            setValues(defaults);
            writeAutosave(defaults);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(triggerRun, RUN_DEBOUNCE_MS);
          }}
        />
        <Splitter dir="col" size={sliderWidth} setSize={setSliderWidth}
                  min={220} max={600} />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <KpiStrip stats={tradeStats} />
          {/* Chart 50% / equity 30% / trades 20% per Niall direction. */}
          <div className="min-h-0" style={{ flex: '0 0 50%' }}>
            <ChartPaneAdapter bars={chartBars} trades={trades} decisions={decisions}
                              tf={tf} setTf={setTf}
                              selectedTradeKey={selectedTradeKey}
                              setSelectedTradeKey={setSelectedTradeKey}
                              runInFlight={runInFlight}
                              runError={runError}
                              onClearError={() => setRunError(null)} />
          </div>
          <div className="min-h-0 border-t border-border" style={{ flex: '0 0 30%' }}>
            <EquityCurve stats={tradeStats} trades={trades}
                         selectedTradeKey={selectedTradeKey}
                         setSelectedTradeKey={setSelectedTradeKey} />
          </div>
          <div className="min-h-0 overflow-y-auto border-t border-border" style={{ flex: '0 0 20%' }}>
            <TradesTable trades={trades} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Starting account balance assumption for the % return KPI. TV's
// strategy report assumes a starting balance too -- this should
// eventually move to a per-session setting (or come from the .set
// file). For now, $50K matches the apparent starting balance in the
// reference screenshot and is a typical futures-account size.
const STARTING_BAL = 50_000;

// ── Toolbar (session status + manual Run + timing) ──
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
      <span className="ml-auto flex items-center gap-2">
        {(runError || (wsStatus === 'error' && startErr)) && (
          <span className="text-short text-[11px]" title={runError || startErr}>
            {wsStatus === 'error' ? 'session error' : 'run error'}
          </span>
        )}
        {runWallMs != null && (
          <span className="text-muted text-[11px] tnum">last {runWallMs.toFixed(0)} ms</span>
        )}
        <button
          onClick={onRun}
          disabled={wsStatus !== 'ready'}
          className="px-3 py-0.5 rounded bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 disabled:opacity-30"
        >
          Run
        </button>
      </span>
    </div>
  );
}

// ── Slider sidebar — schema-driven, all sweepable params ────────────
// Engine 19db867's JSON-keyed RUN dropped the 12-field positional
// cap, so the sidebar now surfaces every sweepable param grouped by
// schema section (instead of just the playground_fields[] subset).
// Each row's value lives in the values dict keyed by the param name.
function SliderPanel({ schema, values, onChange, width, onLoadConfig, onReset }) {
  const sections = useMemo(() => groupSweepableBySection(schema), [schema]);
  return (
    <div style={{ width }}
         className="shrink-0 min-h-0 overflow-y-auto bg-panel">
      {/* Saved-configs header sits above the first section -- the
          load/save controls deserve top billing, not toolbar-corner real
          estate. */}
      <div className="px-2 py-1.5 border-b border-border bg-bg/30 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">configs</span>
        <SavedConfigs
          strategy={STRATEGY}
          currentValues={values}
          onLoad={onLoadConfig}
          onReset={onReset}
        />
      </div>
      {sections.map(s => (
        <SchemaSection
          key={s.id}
          id={`playground.${s.id}`}
          title={s.title}
          badge={`${s.fields.length}`}
          defaultOpen={s.id !== 'lifecycle'}
        >
          {s.fields.map(key => {
            const def = { ...schema.params[key], name: key };
            const active = paramActive(def, values);
            return (
              <ParamRow
                key={key}
                schemaField={def}
                value={values[key]}
                onChange={(v) => onChange(key, v)}
                disabled={!active}
              />
            );
          })}
        </SchemaSection>
      ))}
    </div>
  );
}

// Walk schema.sections, keeping only sweepable params (engine-claude
// marks tunable fields with sweepable: true; everything else is
// deployment-side). Preserves the schema's row/col order within each
// section so the layout matches the sweep UI.
function groupSweepableBySection(schema) {
  if (!schema) return [];
  const out = [];
  for (const sec of (schema.sections || [])) {
    const fields = [];
    for (const row of (sec.rows || [])) {
      for (const col of (row.cols || [])) {
        const key = col.key;
        if (!key) continue;
        const def = schema.params[key];
        if (def?.sweepable) fields.push(key);
      }
    }
    if (fields.length) {
      out.push({ id: sec.id, title: sec.title, fields });
    }
  }
  return out;
}

// Flat list of all sweepable param names — used to seed the values
// dict on first load.
function sweepableKeys(schema) {
  return Object.entries(schema?.params || {})
    .filter(([_, d]) => d.sweepable)
    .map(([k]) => k);
}

// Single-pass walk over trades that produces every stat the KPI strip
// + equity curve consume. Done once per RUN; both panels read off
// this so we don't double-walk the array.
function computeTradeStats(trades, startingBal = 50_000) {
  if (!trades?.length) return null;
  let cum = 0, peak = 0, maxDD = 0, peakAtMaxDD = peak;
  let wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  const equity = new Array(trades.length);
  const pnls   = new Array(trades.length);
  let absMaxPnl = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const p = Number(t.profit ?? t.profit_points ?? 0) || 0;
    pnls[i] = p;
    if (p > 0) { wins++;   sumWin  += p; }
    if (p < 0) { losses++; sumLoss += -p; }
    const ap = Math.abs(p);
    if (ap > absMaxPnl) absMaxPnl = ap;
    cum += p;
    equity[i] = cum;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) { maxDD = dd; peakAtMaxDD = peak; }
  }
  const n      = trades.length;
  const wrPct  = n ? (wins / n) * 100 : 0;
  const pf     = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0);
  const retPct = startingBal > 0 ? (cum / startingBal) * 100 : 0;
  // Max DD as % is computed against the equity peak that produced it
  // (TradingView's "Max equity drawdown %"). Falls back to startingBal
  // if peak < 0 (degenerate).
  const ddBase = Math.max(startingBal, peakAtMaxDD + startingBal, 1);
  const ddPct  = (maxDD / ddBase) * 100;
  return {
    n, wins, losses, sumWin, sumLoss, wrPct, pf,
    finalPnl: cum, peak, maxDD, ddPct,
    retPct, startingBal,
    equity, pnls, absMaxPnl,
  };
}

// ── KPI strip (TV-style: total / DD / count / hit rate / PF) ─────────
function KpiStrip({ stats }) {
  if (!stats) {
    return (
      <div className="bg-panel border-b border-border px-3 py-3 text-[11px] text-muted italic">
        Drag a slider (or click Run) to fire a kernel rerun.
      </div>
    );
  }
  const { n, wins, finalPnl, retPct, maxDD, ddPct, wrPct, pf } = stats;
  const pnlCls = finalPnl >= 0 ? 'text-long' : 'text-short';
  return (
    <div className="bg-panel border-b border-border px-3 py-2 flex items-baseline gap-8 tnum">
      <Kpi label="Total P&L"
           main={<span className={pnlCls}>{fmtUSD(finalPnl)}</span>}
           sub={<span className={pnlCls}>{fmtPct(retPct, true)}</span>} />
      <Kpi label="Max DD"
           main={<span className="text-short">{fmtUSD(-maxDD)}</span>}
           sub={<span className="text-short">{fmtPct(-ddPct, false)}</span>} />
      <Kpi label="Total trades" main={n.toLocaleString()} />
      <Kpi label="Profitable"
           main={<span className={wrPct >= 50 ? 'text-long' : 'text-text'}>
             {fmtPct(wrPct, false)}
           </span>}
           sub={<span className="text-muted">{wins}/{n}</span>} />
      <Kpi label="Profit factor"
           main={<span className={pf >= 1 ? 'text-long' : 'text-short'}>
             {Number.isFinite(pf) ? pf.toFixed(2) : '∞'}
           </span>} />
    </div>
  );
}
function Kpi({ label, main, sub }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-muted text-[10px] uppercase tracking-wide">{label}</span>
      <span className="text-sm font-semibold tnum">
        {main}{sub != null && <span className="text-[11px] ml-1.5">{sub}</span>}
      </span>
    </span>
  );
}

function fmtUSD(v) {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toFixed(0);
}
function fmtPct(v, withSign) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = withSign && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

// ── ChartPane wrapper (bars from coord + per-RUN trades overlay) ────
// Adapts the playground's bars+trades into the slot/ChartPane data
// shape. Bars don't change between RUNs, so the chart stays mounted
// and only the broker (trade markers) layer redraws on each RUN.
function ChartPaneAdapter({ bars, trades, decisions, tf, setTf, selectedTradeKey, setSelectedTradeKey, runInFlight, runError, onClearError }) {
  const data = useMemo(() => {
    if (!bars) return null;
    // Overlay each RUN's MAs from decisions[].xovd onto the static
    // bars (engine 8ca6a69 streams MAs in the decision payload).
    // Falls back to whatever AEIB-loaded value bars[i] already has
    // when decisions don't carry an entry for that bar.
    let withLiveMAs = bars;
    if (decisions && decisions.length) {
      const byBarIdx = new Map();
      for (const d of decisions) {
        if (typeof d.bar_idx === 'number' && d.xovd) {
          byBarIdx.set(d.bar_idx, d.xovd);
        }
      }
      if (byBarIdx.size > 0) {
        withLiveMAs = bars.map((b, i) => {
          const x = byBarIdx.get(i);
          if (!x) return b;
          return {
            ...b,
            fast_ma: x.fast_ma ?? b.fast_ma,
            slow_ma: x.slow_ma ?? b.slow_ma,
            atr:     x.atr     ?? b.atr,
          };
        });
      }
    }
    return {
      bars: withLiveMAs,
      broker: tradesToBroker(trades || []),
      trades: tradesToBroker(trades || []),
      decisions: decisions || [],
      audit: [],
    };
  }, [bars, trades, decisions]);

  if (!bars) {
    return (
      <div className="h-full flex items-center justify-center text-[11px] text-muted">
        loading bars…
      </div>
    );
  }
  return (
    <div className="relative h-full">
      <ChartPane
        data={data}
        tf={tf}
        setTf={setTf}
        runnerId="playground"
        selectedTradeKey={selectedTradeKey}
        setSelectedTradeKey={setSelectedTradeKey}
      />
      {runInFlight && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20
                        flex items-center gap-2 px-2.5 py-1 rounded-full
                        bg-panel/90 backdrop-blur-sm border border-border
                        text-[10px] text-muted shadow-lg">
          <span className="inline-block w-3 h-3 rounded-full
                            border-2 border-accent/30 border-t-accent
                            animate-spin" />
          running…
        </div>
      )}
      {runError && !runInFlight && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30
                        max-w-[80%] px-4 py-2.5 rounded-md
                        bg-short/90 backdrop-blur-sm border border-short
                        text-text shadow-2xl
                        flex items-start gap-3">
          <span className="text-lg leading-none">⚠</span>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-semibold uppercase tracking-wide">
              Run error
            </div>
            <div className="text-[11px] mt-0.5 break-all whitespace-pre-wrap">
              {runError}
            </div>
          </div>
          <button
            onClick={onClearError}
            title="dismiss"
            className="text-text/70 hover:text-text text-lg leading-none px-1"
          >×</button>
        </div>
      )}
    </div>
  );
}

// xovdV1Server trade -> ChartPane's broker-shape. Field names follow
// HistoricalDataProvider.vizTradesToBroker so future merges stay
// compatible if the legacy and live shapes converge.
function tradesToBroker(trades) {
  const DIR_TO_SIDE = { LONG: 'long', SHORT: 'short', L: 'long', S: 'short' };
  const REASON_MAP = {
    TP: 'tp', SL: 'sl', TRAIL: 'trail',
    LIMIT: 'cross', MAXBARS: 'maxbars', SESSION: 'eostream', MARKET: 'cross',
  };
  return trades.map((t, i) => {
    const dir = String(t.dir || (t.direction === 1 ? 'LONG' : 'SHORT')).toUpperCase();
    const reason = String(t.exit_reason || t.reason || '').toUpperCase();
    return {
      trade_id: t.id ?? i,
      side:     DIR_TO_SIDE[dir] || dir.toLowerCase(),
      qty:      t.size ?? t.qty ?? 0,
      entry_ts: (t.entry_time ?? Math.floor((t.entry_ns ?? 0) / 1e9)) * 1e9,
      entry_px: t.entry_price ?? t.entry_px ?? 0,
      exit_ts:  (t.exit_time ?? Math.floor((t.exit_ns ?? 0) / 1e9)) * 1e9,
      exit_px:  t.exit_price ?? t.exit_px ?? 0,
      pnl:      t.profit ?? t.profit_points ?? 0,
      reason:   REASON_MAP[reason] || reason.toLowerCase(),
      comm:     0,
      sl_price: t.sl_price ?? 0,
      tp_price: t.tp_price ?? 0,
    };
  });
}

// MNQ tick value: $0.50/tick. Hardcoded today; future per-session
// metadata (symbol-aware) replaces this so non-MNQ datasets read
// excursion dollars correctly.
const TICK_VALUE_USD = 0.5;

// ── Equity curve + per-trade profit bars + right-edge $ axis ────────
// SVG layout (fixed viewBox W*H, preserveAspectRatio=none for stretch):
//   [equity track]   y in [0, H_EQ]              cumulative-$ line
//   [bar track]      y in [H_EQ + GAP, H]        per-trade green/red bars
//   right-edge labels: $ ticks on the equity axis
//
// Lock-Y persists a snapshotted [lo, hi] range to localStorage; while
// locked, the axis stays put across runs so two slider configurations
// can be compared at the same scale (lifted from the legacy
// strategy-visualizer/playground.html).
function EquityCurve({ stats, trades, selectedTradeKey, setSelectedTradeKey }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [lockedRange, setLockedRange] = useState(() => {
    try {
      const raw = window.localStorage.getItem('playground.equity.lockY.v1');
      if (!raw) return null;
      const r = JSON.parse(raw);
      return (r && Number.isFinite(r.lo) && Number.isFinite(r.hi)) ? r : null;
    } catch { return null; }
  });
  if (!stats) {
    return (
      <div className="bg-panel border-b border-border px-3 py-2 text-[10px] text-muted/70 italic h-full">
        Equity curve -- drag a slider or click Run to populate.
      </div>
    );
  }
  const { equity, pnls, finalPnl, peak, maxDD, absMaxPnl } = stats;
  const n = equity.length;

  // viewBox math. Right-pad reserves room for the $ tick labels.
  const W = 1000, H = 240, PAD_L = 4, PAD_R = 60;
  const H_EQ = Math.round(H * 0.72);
  const GAP  = 4;
  const BAR_TOP = H_EQ + GAP;
  const BAR_H   = H - BAR_TOP - 2;

  const fitLo = Math.min(0, ...equity);
  const fitHi = Math.max(0, ...equity);
  const lo = lockedRange ? lockedRange.lo : fitLo;
  const hi = lockedRange ? lockedRange.hi : fitHi;
  const span = (hi - lo) || 1;
  const xOf = (i) => PAD_L + (i / Math.max(1, n - 1)) * (W - PAD_L - PAD_R);
  const yOf = (v) => H_EQ - 2 - ((v - lo) / span) * (H_EQ - 4);
  const zeroY = yOf(0);
  const path  = equity.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  // Hard-split stroke color at the y=0 line via a userSpaceOnUse
  // linearGradient: above-zero is green (long), below-zero is red
  // (short). Solo color when the run never crosses zero.
  const zeroPct = Math.max(0, Math.min(1, zeroY / H_EQ)) * 100;
  const ticks = niceTicks(lo, hi, 4);

  const toggleLock = () => {
    if (lockedRange) {
      // Unlock: drop snapshot, axis goes back to auto-fit per-run.
      setLockedRange(null);
      try { window.localStorage.removeItem('playground.equity.lockY.v1'); } catch {}
    } else {
      // Lock: snapshot the *current* (auto-fit) range so the next run
      // is rendered at the same scale.
      const snap = { lo: fitLo, hi: fitHi };
      setLockedRange(snap);
      try { window.localStorage.setItem('playground.equity.lockY.v1', JSON.stringify(snap)); } catch {}
    }
  };

  const selectedIdx = selectedTradeKey != null
    ? findTradeIndexByEntryNs(trades, selectedTradeKey)
    : -1;

  // Per-trade bars: each trade gets one bar. For dense series, the bar
  // width may be < 1px — that's fine, browsers anti-alias and the
  // overall shape conveys streaks/concentration.
  const barW = Math.max(1, (W - PAD_L - PAD_R) / Math.max(1, n) - 0.5);
  const barX0 = (i) => xOf(i) - barW / 2;
  const hOf = (p) => (absMaxPnl > 0 ? (Math.abs(p) / absMaxPnl) * (BAR_H / 2 - 1) : 0);
  const barMid = BAR_TOP + BAR_H / 2;

  // Map cursor screen-x → trade index. SVG uses preserveAspectRatio=none
  // so each viewBox-x unit scales proportionally to the rendered width;
  // pct of [PAD_L .. W-PAD_R] maps directly to bar index 0..n-1.
  const onMove = (e) => {
    const el = wrapRef.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const usableLeft  = (PAD_L / W) * rect.width;
    const usableRight = ((W - PAD_R) / W) * rect.width;
    const usableW = usableRight - usableLeft;
    if (usableW <= 0) return;
    const t = (px - usableLeft) / usableW;
    if (t < -0.02 || t > 1.02) { setHover(null); return; }
    const idx = Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    setHover({ idx, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  const onLeave = () => setHover(null);
  const onClick = () => {
    if (!hover || !setSelectedTradeKey) return;
    const t = trades?.[hover.idx];
    if (!t) return;
    const entryNs = (t.entry_time ?? Math.floor((t.entry_ns ?? 0) / 1e9)) * 1e9;
    setSelectedTradeKey(entryNs);
  };

  const tip = hover ? buildTradeTip(hover, trades, equity) : null;

  return (
    <div className="bg-panel px-3 py-1 h-full flex flex-col min-h-0 relative" ref={wrapRef}>
      <div className="flex items-baseline gap-4 text-[10px] shrink-0">
        <span className="text-muted uppercase tracking-wide">equity</span>
        <span className={'tnum font-semibold ' + (finalPnl >= 0 ? 'text-long' : 'text-short')}>
          {fmtUSD(finalPnl)}
        </span>
        <span className="text-muted tnum">peak <span className="text-text">{fmtUSD(peak)}</span></span>
        <span className="text-muted tnum">max DD <span className="text-short">{fmtUSD(-maxDD)}</span></span>
        <button
          type="button"
          onClick={toggleLock}
          title={lockedRange
            ? `Y axis locked at [${fmtAxis(lockedRange.lo)}, ${fmtAxis(lockedRange.hi)}] -- click to unlock`
            : 'Lock current Y range so the next run renders at the same scale (compare slider configs)'}
          className={'ml-2 px-1.5 py-0 rounded border text-[9px] uppercase tracking-wider font-bold ' +
            (lockedRange
              ? 'bg-accent/20 text-accent border-accent/60'
              : 'bg-bg text-muted border-border hover:text-text hover:border-muted')}
        >
          lock Y{lockedRange ? ' on' : ''}
        </button>
        <span className="ml-auto text-[9px] text-muted/60 uppercase tracking-wide">trade #</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick}
           className="block w-full flex-1 min-h-0 cursor-crosshair">
        <defs>
          {/* Hard-split stroke: green above the zeroY line, red below.
              userSpaceOnUse so the stop offsets are absolute viewBox y. */}
          <linearGradient id="equityStrokeSplit"
                          gradientUnits="userSpaceOnUse"
                          x1="0" y1="0" x2="0" y2={H_EQ}>
            <stop offset="0%"            stopColor="#26a69a" />
            <stop offset={`${zeroPct}%`} stopColor="#26a69a" />
            <stop offset={`${zeroPct}%`} stopColor="#ef5350" />
            <stop offset="100%"          stopColor="#ef5350" />
          </linearGradient>
        </defs>
        {/* Y-axis grid + $ labels (zero line punched brighter + thicker) */}
        {ticks.map((v, k) => {
          const y = yOf(v);
          const isZero = v === 0;
          return (
            <g key={k}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
                    stroke={isZero ? '#7c8190' : '#2a2e36'}
                    strokeWidth={isZero ? 1.25 : 0.5}
                    strokeDasharray={isZero ? '0' : '2 3'} />
              <text x={W - PAD_R + 4} y={y + 3}
                    fontSize="10" fill={isZero ? '#d4d7dd' : '#7c8190'}
                    fontFamily="ui-monospace, Menlo, Consolas, monospace">
                {fmtAxis(v)}
              </text>
            </g>
          );
        })}
        {/* Zero reference inside the bar track */}
        <line x1={PAD_L} y1={barMid} x2={W - PAD_R} y2={barMid}
              stroke="#2a2e36" strokeWidth="0.5" />
        {/* Per-trade bars */}
        {pnls.map((p, i) => {
          if (!p) return null;
          const h = hOf(p);
          const y = p > 0 ? barMid - h : barMid;
          return (
            <rect key={i}
                  x={barX0(i)} y={y}
                  width={barW} height={Math.max(0.5, h)}
                  fill={p > 0 ? '#26a69a' : '#ef5350'}
                  opacity="0.7" />
          );
        })}
        {/* Equity line on top -- gradient stroke renders red below zero. */}
        <path d={path} fill="none" stroke="url(#equityStrokeSplit)" strokeWidth="1.5" />
        {/* Selected-trade pin (from chart click or here-click). Re-keyed
            on selectedTradeKey so the .equity-pin CSS animation
            restarts -- exponential fade with ~1.2s half-life. */}
        {selectedIdx >= 0 && (
          <line key={selectedTradeKey}
                className="equity-pin"
                x1={xOf(selectedIdx)} y1={0} x2={xOf(selectedIdx)} y2={H}
                stroke="#facc15" strokeWidth="1" />
        )}
        {/* Hover crosshair */}
        {hover && (
          <line x1={xOf(hover.idx)} y1={0} x2={xOf(hover.idx)} y2={H}
                stroke="#5fa8ff" strokeWidth="0.75" strokeDasharray="2 2" opacity="0.6" />
        )}
      </svg>
      {tip && <TradeTip data={tip} x={hover.x} y={hover.y} />}
    </div>
  );
}

// Build the tooltip payload from (hover, trades, cumulative-equity).
// Renders empty when trade index is past end (no trade for that bin).
function buildTradeTip(hover, trades, equity) {
  const t = trades?.[hover.idx];
  if (!t) return null;
  const dir = String(t.dir || (t.direction === 1 ? 'LONG' : 'SHORT')).toUpperCase();
  const cum = equity[hover.idx] ?? 0;
  const realized = Number(t.profit ?? t.profit_points ?? 0);
  const mfeT = Number(t.mfe_ticks ?? 0);
  const maeT = Number(t.mae_ticks ?? 0);
  const qty  = Number(t.size ?? t.qty ?? 1);
  return {
    n:      hover.idx + 1,
    dir,
    realized,
    cum,
    mfeT,
    maeT,
    mfeUsd: mfeT * TICK_VALUE_USD * qty,
    maeUsd: maeT * TICK_VALUE_USD * qty,
    ts:     t.entry_time ? new Date(t.entry_time * 1000) : null,
    exit_reason: t.exit_reason || t.reason || '',
  };
}

// Locate a trade by its entry timestamp (ns). Used to show the
// selected-trade pin in the equity panel when ChartPane sets the key.
function findTradeIndexByEntryNs(trades, ns) {
  if (!trades || ns == null) return -1;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const tns = (t.entry_time ?? Math.floor((t.entry_ns ?? 0) / 1e9)) * 1e9;
    if (tns === ns) return i;
  }
  return -1;
}

// TV-style floating tooltip: trade #, dir, cumulative P&L, favorable
// + adverse excursion (ticks AND $), entry timestamp.
function TradeTip({ data, x, y }) {
  // Position so the tooltip sits above-right of the cursor without
  // colliding with it. Clamps inside the parent panel.
  const W = 230, H = 130;
  const left = Math.min(Math.max(8, x + 14), 9999);    // outer container clips
  const top  = Math.max(8, y - H - 10);
  return (
    <div className="absolute z-30 pointer-events-none"
         style={{ left, top, width: W, minHeight: H }}>
      <div className="bg-panel/95 backdrop-blur-sm border border-border rounded shadow-2xl px-3 py-2 text-[11px]">
        <div className="text-muted text-center pb-1 border-b border-border/40 mb-1.5">
          Trade #{data.n}{' '}
          <span className={data.dir.startsWith('L') ? 'text-long' : 'text-short'}>
            {data.dir.charAt(0) + data.dir.slice(1).toLowerCase()}
          </span>
        </div>
        <Row label="Realized P&L"
             dot={data.realized >= 0 ? '#26a69a' : '#ef5350'}
             value={fmtUSD(data.realized)}
             cls={data.realized >= 0 ? 'text-long' : 'text-short'} />
        <Row label="Cumulative P&L"
             dot="#5fa8ff"
             value={fmtUSD(data.cum)}
             cls={data.cum >= 0 ? 'text-long' : 'text-short'} />
        <Row label="Favorable excursion"
             dot="#26a69a"
             value={`${fmtUSD(data.mfeUsd)} (${data.mfeT}t)`}
             cls="text-long" />
        <Row label="Adverse excursion"
             dot="#ef5350"
             value={`${fmtUSD(data.maeUsd)} (${data.maeT}t)`}
             cls="text-short" />
        {data.ts && (
          <div className="text-muted text-[10px] text-center pt-1">
            {data.ts.toLocaleString([], {
              weekday: 'short', month: 'short', day: '2-digit',
              year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
            })}
          </div>
        )}
        {data.exit_reason && (
          <div className="text-muted/60 text-[9px] text-center uppercase tracking-wide">
            exit {String(data.exit_reason).toLowerCase()}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, dot, value, cls = '' }) {
  return (
    <div className="flex items-center justify-between py-px tnum">
      <span className="flex items-center gap-1.5 text-muted">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: dot }} />
        {label}
      </span>
      <span className={cls + ' font-semibold'}>{value}</span>
    </div>
  );
}

// Pick ~n nice round-number ticks across [lo, hi]. Heuristic ladder
// (1, 2, 5, 10 x power of 10) — same flavor as d3.ticks() without
// the dependency.
function niceTicks(lo, hi, target = 4) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const rough = span / target;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  const step  = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(lo / step) * step;
  const out   = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
function fmtAxis(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1000)      return `${sign}$${Math.round(a / 1000)}K`;
  return `${sign}$${Math.round(a)}`;
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
function readAutosave() {
  try {
    const raw = window.localStorage.getItem(LS_AUTOSAVE);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch { return null; }
}
function writeAutosave(values) {
  try { window.localStorage.setItem(LS_AUTOSAVE, JSON.stringify(values)); } catch {}
}
