// Candle pane (lightweight-charts) + MA overlays + trade-marker overlay
// canvas. Lifts strategy-visualizer/index.html's pattern.
//
// Lifecycle:
//   - Mount: createChart, candle + MA series. fitContent ONCE on the
//     initial REST seed.
//   - Live updates: chart.update(b) on each new bar reference (forming
//     bar updates in place, new bars append). Visible range stays put
//     so user pan/zoom is preserved.
//   - Trade markers: drawn from data.broker (real fills), not the
//     sparse sim derivation. rAF redraw loop keeps them glued to the
//     candle pane during pan/zoom.
//   - Click candle: find broker trade overlapping that bar, set
//     selectedTradeKey (= entry_ts).
//   - selectedTradeKey change: pan chart so the selected trade's
//     entry bar is centered.

import { useEffect, useMemo, useRef, useState } from 'react';
// v5 API: series types are passed to chart.addSeries() rather than via
// dedicated addCandlestickSeries / addLineSeries methods. This unlocks
// native multi-pane support (pass pane index as 3rd arg to addSeries).
import { createChart, CrosshairMode, CandlestickSeries, LineSeries } from 'lightweight-charts';

// Persist chart pan/zoom across slot switches via localStorage. Logical
// range (bar-index based) survives well across data reloads because
// new bars push the index forward consistently. Saved per-runner so
// switching runners doesn't restore a wildly-wrong window.
const PERSIST_KEY_BASE = 'algoengine.chartView.v1';
function persistKey(runnerId) { return `${PERSIST_KEY_BASE}.${runnerId || 'default'}`; }
function loadView(runnerId) {
  try {
    const raw = window.localStorage.getItem(persistKey(runnerId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveView(runnerId, view) {
  try { window.localStorage.setItem(persistKey(runnerId), JSON.stringify(view)); } catch {}
}

// Delay before the gate-hover tooltip appears on a dim bar. Avoids
// flashing while the user just mouses around. Once visible, the
// tooltip tracks the cursor without re-debounce.
const GATE_HOVER_DELAY_MS = 500;

const TF_OPTIONS = [
  { sec: 180, label: 'M3' },
  { sec: 900, label: 'M15' },
  { sec: 1800, label: 'M30' },
  { sec: 3600, label: 'H1' },
];

export default function ChartPane({ data, tf, setTf, selectedTradeKey, setSelectedTradeKey, runnerId, onChartReady, live = false }) {
  const wrapRef = useRef(null);
  const chartDivRef = useRef(null);
  const overlayRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const lastBarRef = useRef(null);   // last bar ref-eq pushed to chart
  const restoredRef = useRef(false);  // have we restored saved view yet?
  // Floating tooltip shown while the user hovers a candle whose decision
  // was blocked. Mirrors StrategyStatePanel's GateRow list, but
  // bar-specific.
  const [gateHover, setGateHover] = useState(null);  // { x, y, decision } or null
  // Mirror of gateHover for synchronous reads inside the crosshair
  // handler (which is set up once at mount).
  const gateHoverRef = useRef(null);
  // Debounce state for hover-intent: { timer, barTime, pos, decision }.
  const hoverPendingRef = useRef({ timer: null, barTime: null });
  // Re-renders dependent effects after chartRef is populated. Refs
  // don't trigger re-renders, so without this the hover-handler
  // effect would see chartRef.current === null on first run and miss.
  const [chartReady, setChartReady] = useState(false);

  // Build chart once.
  useEffect(() => {
    const el = chartDivRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { color: '#0f1115' }, textColor: '#d4d7dd' },
      grid:   { vertLines: { color: '#1a1d23' }, horzLines: { color: '#1a1d23' } },
      rightPriceScale: { borderColor: '#2a2e36' },
      timeScale: {
        borderColor: '#2a2e36',
        timeVisible: true,
        secondsVisible: false,
        // Shift the visible range left by one bar width when a new bar
        // is appended, so the latest bar stays at the same offset from
        // the right edge that the user has scrolled/zoomed to. Without
        // this, new bars accumulate beyond the visible range and the
        // latest bar slowly creeps off-screen. Note: in-place updates to
        // the forming bar (per-second close moves) do NOT count as new
        // bars — those only repaint the rightmost bar in place.
        shiftVisibleRangeOnNewBar: true,
        rightOffset: 5,
        // Render axis ticks in the browser's local timezone (default
        // is UTC). ts_ns from the runner is UTC, Date() converts.
        tickMarkFormatter: (time) => {
          const d = new Date(time * 1000);
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        },
      },
      // Crosshair tooltip + price scale time labels also in local TZ.
      localization: {
        timeFormatter: (time) => {
          const d = new Date(time * 1000);
          return d.toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        },
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });
    // Candle palette from playground.html: yellow=up, cyan=down.
    // Saturated (not the washed-out tones the visualizer used).
    const candles = chart.addSeries(CandlestickSeries, {
      upColor:    '#FFF59D', downColor:    '#80DEEA', borderVisible: false,
      wickUpColor:'#FFF59D', wickDownColor:'#80DEEA',
    });
    // MA palette: purple fast, saturated blue slow. Per user spec.
    const fastMa = chart.addSeries(LineSeries, { color: '#E040FB', lineWidth: 3, priceLineVisible: false, lastValueVisible: false });
    const slowMa = chart.addSeries(LineSeries, { color: '#2962FF', lineWidth: 3, priceLineVisible: false, lastValueVisible: false });

    // Click-on-candle -> open the trade whose entry-bar is the bar
    // clicked. Checks BOTH broker fills (solid triangles) AND algo
    // intents (hollow triangles) so an algo-only trade (the runner
    // POSTed but the broker didn't fill, e.g. cap-suppressed) is
    // still clickable. Broker is checked first so paired trades
    // resolve to the broker side (canonical) -- the modal then
    // surfaces the algo counterpart in its summary.
    //
    // Match by exact bar bucket: subBarX renders markers within the
    // bar they actually fired in (10% inset on each edge), so the
    // entry-bar bucket and the visual marker line up 1:1.
    chart.subscribeClick((param) => {
      if (!param?.time) return;
      const tfNow = currentTfRef.current;
      const clickSec = Number(param.time);
      const matches = (t) => {
        const eb = Math.floor(t.entry_ts / 1e9 / tfNow) * tfNow;
        return eb === clickSec;
      };
      // Prefer real broker fill > real algo intent > ad-hoc (just the
      // bar's open ts, no trade context). Ad-hoc clicks open the tick
      // modal in inspect-only mode -- ticks visible, no entry/exit
      // markers or bracket lines, prev/next still navigates algo bars.
      const broker = currentBrokerRef.current || [];
      for (const t of broker) {
        if (matches(t)) { setSelectedTradeKeyRef.current(t.entry_ts); return; }
      }
      const algos = currentTradesRef.current || [];
      for (const t of algos) {
        if (matches(t)) { setSelectedTradeKeyRef.current(t.entry_ts); return; }
      }
      // No trade on this bar -- ad-hoc tick view at bar open.
      setSelectedTradeKeyRef.current(clickSec * 1e9);
    });

    chartRef.current = chart;
    seriesRef.current = { candles, fastMa, slowMa };
    // Signal to dependent effects (e.g. crosshair hover handler) that
    // the chart instance is now usable. setChartReady triggers a
    // re-render so they get a chance to bind.
    setChartReady(true);
    // Notify external owners (e.g. Historical's side-by-side time-scale
    // sync) that the chart instance is available. Fires once at mount.
    if (onChartReady) onChartReady(chart);

    // Save logical-range to localStorage on every user pan/zoom (debounced).
    // Logical range survives bar-append better than time range — when a new
    // bar arrives, the rightmost logical-coord stays anchored.
    let saveTimer = null;
    const onRangeChange = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const lr = chart.timeScale().getVisibleLogicalRange();
        if (lr) saveView(currentRunnerIdRef.current, { lr_from: lr.from, lr_to: lr.to });
      }, 250);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      if (hoverPendingRef.current.timer) {
        clearTimeout(hoverPendingRef.current.timer);
        hoverPendingRef.current.timer = null;
      }
      chart.remove();
      chartRef.current = null;
      lastBarRef.current = null;
      restoredRef.current = false;
    };
  }, []);

  // runnerId ref so the listener (set up at mount) reads the latest value.
  const currentRunnerIdRef = useRef(runnerId);
  useEffect(() => { currentRunnerIdRef.current = runnerId; }, [runnerId]);

  // Refs for click/hover handlers so we don't recreate the chart when
  // broker / decisions / tf / setSelectedTradeKey change.
  const currentBrokerRef = useRef(data?.broker || []);
  const currentTradesRef = useRef(data?.trades || []);
  const currentDecisionsRef = useRef(data?.decisions || []);
  const currentTfRef = useRef(tf);
  const setSelectedTradeKeyRef = useRef(setSelectedTradeKey);
  useEffect(() => { currentBrokerRef.current = data?.broker || []; }, [data?.broker]);
  useEffect(() => { currentTradesRef.current = data?.trades || []; }, [data?.trades]);
  useEffect(() => { currentDecisionsRef.current = data?.decisions || []; }, [data?.decisions]);
  useEffect(() => { currentTfRef.current = tf; }, [tf]);
  useEffect(() => { setSelectedTradeKeyRef.current = setSelectedTradeKey; }, [setSelectedTradeKey]);

  // Hover-on-candle -> show the gate-priority breakdown for the
  // decision that applies to that bar. A decision's ts_ns is the
  // close of its source bar (= open of the bar it APPLIES to), so
  // the bar visually showing the dim/missing limit segment maps to
  // `floor(d.ts_ns/1e9) === param.time`.
  //
  // Visibility rule (matches the limit-line rendering): tooltip shows
  // ONLY when the bar would render a DIM limit segment — i.e.
  // classifyDecision returns a '*_dim' class. Bars with a hidden
  // segment have no tooltip; bright bars have no block to show.
  //
  // Hover-intent: once the cursor settles on a dim bar, wait
  // GATE_HOVER_DELAY_MS before showing — avoids flashing while the
  // user is panning. Once visible, position tracks the cursor.
  //
  // Registered in its own effect (not in the chart-mount effect) so
  // HMR-swapping this file cleanly replaces the closure: cleanup
  // unsubscribes the previous handler before the new one binds.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param) => {
      let cand = null;
      if (param?.time && param?.point) {
        const decs = currentDecisionsRef.current;
        if (decs?.length) {
          const tSec = Number(param.time);
          const found = decs.find(d => Math.floor(d.ts_ns / 1e9) === tSec);
          if (found) {
            const inTrade = (found.open_qty || 0) !== 0;
            const cls = inTrade ? null : classifyDecision(found);
            // Fire on ANY classified bar — both _dim (gate blocked the
            // attempt) AND _bright (all gates passed, order placed).
            // Both carry the same Contributors and the gate breakdown
            // is informative either way.
            if (cls) {
              cand = { x: param.point.x, y: param.point.y, decision: found, tSec };
            }
          }
        }
      }
      const pend = hoverPendingRef.current;
      if (!cand) {
        if (pend.timer) { clearTimeout(pend.timer); pend.timer = null; }
        pend.barTime = null;
        if (gateHoverRef.current) { gateHoverRef.current = null; setGateHover(null); }
        return;
      }
      if (gateHoverRef.current
          && Math.floor(gateHoverRef.current.decision.ts_ns / 1e9) === cand.tSec) {
        const next = { x: cand.x, y: cand.y, decision: cand.decision };
        gateHoverRef.current = next;
        setGateHover(next);
        return;
      }
      if (pend.barTime === cand.tSec) {
        pend.pos = { x: cand.x, y: cand.y };
        pend.decision = cand.decision;
        return;
      }
      if (pend.timer) clearTimeout(pend.timer);
      pend.barTime = cand.tSec;
      pend.pos = { x: cand.x, y: cand.y };
      pend.decision = cand.decision;
      pend.timer = setTimeout(() => {
        const next = { x: pend.pos.x, y: pend.pos.y, decision: pend.decision };
        gateHoverRef.current = next;
        setGateHover(next);
        pend.timer = null;
        pend.barTime = null;
      }, GATE_HOVER_DELAY_MS);
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      const pend = hoverPendingRef.current;
      if (pend.timer) { clearTimeout(pend.timer); pend.timer = null; }
      pend.barTime = null;
    };
  }, [chartReady]);

  // Aggregated bars memo — recompute only when bars array or tf change.
  const aggregated = useMemo(
    () => data ? aggregateBars(data.bars, tf) : [],
    [data?.bars, tf]
  );

  // Initial setData on first non-empty data, or on TF change.
  // First-ever mount: restore saved logical-range (per runnerId).
  // After that, we use chart.update() on incremental changes so the
  // user's pan/zoom is preserved.
  useEffect(() => {
    if (!chartRef.current || !aggregated.length) return;
    const { candles, fastMa, slowMa } = seriesRef.current;
    if (!restoredRef.current || tfChangedRef.current) {
      const candleData = dedupeByTime(aggregated.map(b => ({
        time: Math.floor(b.ts_ns / 1e9),
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      candles.setData(candleData);
      fastMa.setData(dedupeByTime(aggregated
        .filter(b => b.fast_ma > 0)
        .map(b => ({ time: Math.floor(b.ts_ns / 1e9), value: b.fast_ma }))));
      slowMa.setData(dedupeByTime(aggregated
        .filter(b => b.slow_ma > 0)
        .map(b => ({ time: Math.floor(b.ts_ns / 1e9), value: b.slow_ma }))));
      if (!restoredRef.current) {
        // Try to restore saved view; fall back to fitContent if none.
        const saved = loadView(runnerId);
        if (saved && Number.isFinite(saved.lr_from) && Number.isFinite(saved.lr_to)) {
          chartRef.current.timeScale().setVisibleLogicalRange({
            from: saved.lr_from, to: saved.lr_to,
          });
        } else {
          chartRef.current.timeScale().fitContent();
        }
        restoredRef.current = true;
      }
      tfChangedRef.current = false;
      lastBarRef.current = aggregated[aggregated.length - 1];
    } else {
      // Incremental:
      //
      // CANDLES via update() — only for bars at or after the chart's
      // current last time. lightweight-charts v5's update() throws
      // "Cannot update oldest data" if called with a time older than
      // the series' last data point. The forming bar / latest-closing
      // bar always satisfies this constraint.
      //
      // MA series via setData() with the full ordered set — required
      // because a late-arriving decision merges MA into an older bar
      // (decision for N arrives after bar_update for N+1 has advanced
      // the chart). v5 doesn't let update() touch older data, so we
      // replay the whole MA series. setData is O(N) but N is bounded
      // (hundreds, maybe a few thousand bars) and it does NOT reset
      // the chart's visible range — user pan/zoom is preserved.
      //
      // Defensive sort: onDecision's fallback may append a synthesized
      // bar at an older ts_ns; setData requires ascending order.
      const lastTime = lastBarRef.current
        ? Math.floor(lastBarRef.current.ts_ns / 1e9)
        : -Infinity;
      for (const b of aggregated) {
        const t = Math.floor(b.ts_ns / 1e9);
        if (t < lastTime) continue;
        candles.update({ time: t, open: b.open, high: b.high, low: b.low, close: b.close });
      }
      const fastData = dedupeByTime(aggregated
        .filter(b => b.fast_ma > 0)
        .map(b => ({ time: Math.floor(b.ts_ns / 1e9), value: b.fast_ma }))
        .sort((a, b) => a.time - b.time));
      const slowData = dedupeByTime(aggregated
        .filter(b => b.slow_ma > 0)
        .map(b => ({ time: Math.floor(b.ts_ns / 1e9), value: b.slow_ma }))
        .sort((a, b) => a.time - b.time));
      fastMa.setData(fastData);
      slowMa.setData(slowData);
      lastBarRef.current = aggregated[aggregated.length - 1];
    }
  }, [aggregated, tf]);

  // Track TF change so the next data effect does a full reload.
  const tfChangedRef = useRef(false);
  const prevTfRef = useRef(tf);
  useEffect(() => {
    if (prevTfRef.current !== tf) {
      tfChangedRef.current = true;
      lastBarRef.current = null;
      prevTfRef.current = tf;
    }
  }, [tf]);

  // rAF overlay loop for trade markers + block markers.
  // markerStats updated via ref + throttled state push for the HUD.
  const markerStatsRef = useRef({ drawn: 0, total: 0 });
  const [markerStats, setMarkerStats] = useState({ drawn: 0, total: 0 });
  useEffect(() => {
    let id, lastPush = 0;
    const tick = () => {
      const stats = drawOverlay(chartRef.current, seriesRef.current.candles,
                  overlayRef.current, wrapRef.current,
                  data, tf, selectedTradeKey);
      if (stats) {
        markerStatsRef.current = stats;
        const now = performance.now();
        if (now - lastPush > 500) {
          lastPush = now;
          setMarkerStats(stats);
        }
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [data, tf, selectedTradeKey]);

  // Pan to selected trade — ONLY when the selection actually changes.
  // Earlier this effect listed `data` as a dep, which meant every tick
  // (which mutates `data`) re-snapped the chart back to the selection
  // and clobbered the user's manual scroll. Read `data` via ref instead.
  // Searches BOTH broker and algo trades (TradeTable rows can be keyed
  // by the algo entry_ts when broker hasn't filled yet, or by the
  // broker entry_ts for paired/orphan-broker rows).
  const dataForPanRef = useRef(data);
  useEffect(() => { dataForPanRef.current = data; }, [data]);
  useEffect(() => {
    if (!chartRef.current || selectedTradeKey == null) return;
    const d = dataForPanRef.current;
    if (!d) return;
    const t = (d.broker || []).find(t => t.entry_ts === selectedTradeKey)
           || (d.trades || []).find(t => t.entry_ts === selectedTradeKey);
    if (!t) return;
    const ts = Math.floor(t.entry_ts / 1e9);
    const tfSnap = Math.floor(ts / tf) * tf;
    const range = chartRef.current.timeScale().getVisibleRange();
    if (range) {
      const width = range.to - range.from;
      chartRef.current.timeScale().setVisibleRange({
        from: tfSnap - width / 2,
        to:   tfSnap + width / 2,
      });
    }
  }, [selectedTradeKey, tf]);

  return (
    <div ref={wrapRef} className="relative w-full h-full">
      {/* TF picker + fit button — bottom-left of the candle area.
          left-14 clears the lightweight-charts TV watermark; bottom-9
          sits above the time-axis gutter labels. */}
      <div className="absolute bottom-9 left-14 z-20 flex gap-1 text-[11px]">
        {TF_OPTIONS.map(o => (
          <button
            key={o.sec}
            onClick={() => setTf(o.sec)}
            className={`px-2 py-0.5 rounded ${
              tf === o.sec
                ? 'bg-accent/20 text-text border border-accent'
                : 'bg-panel/90 border border-border text-muted hover:text-text'
            }`}
          >
            {o.label}
          </button>
        ))}
        <button
          onClick={() => {
            chartRef.current?.timeScale().fitContent();
          }}
          className="ml-1 px-2 py-0.5 rounded bg-panel/90 border border-border text-muted hover:text-text"
          title="Fit all data on screen (use to find off-screen trade arrows)"
        >
          fit
        </button>
      </div>
      {live && (
        <div className="absolute top-2 right-2 z-10 px-2 py-0.5 rounded bg-panel/90 border border-border text-[10px] text-muted tnum flex items-center gap-3">
          <BarCloseCountdown periodSec={tf} />
          <span className="opacity-60">
            broker {data?.broker?.length || 0} · markers {markerStats.drawn}/{markerStats.total}
            {markerStats.outOfRange > 0 && <> · <span className="text-trail">{markerStats.outOfRange} off-range</span></>}
          </span>
        </div>
      )}
      <div ref={chartDivRef} className="absolute inset-0" />
      {/* z-index 10: lightweight-charts creates an internal stacking
          context with its own canvases. Without explicit z-index here
          the overlay can render BELOW the candle layer. (Same trick as
          strategy-visualizer/index.html #overlay.) */}
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }} />
      {gateHover && <GateHoverTip {...gateHover} wrapRef={wrapRef} />}
      {/* Bottom-center "→ live" reset, sits just above the time-scale
          gutter — same spot TradingView's own scroll-to-realtime lives. */}
      <button
        onClick={() => chartRef.current?.timeScale().scrollToRealTime()}
        title="Scroll to most recent bar"
        className="absolute bottom-7 left-1/2 -translate-x-1/2 z-20 w-7 h-7 rounded-full bg-panel/90 border border-border text-muted hover:text-text hover:border-accent flex items-center justify-center"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <polyline points="3 4 3 10 9 10" />
        </svg>
      </button>
    </div>
  );
}

// Gate-priority hover tooltip — replicates StrategyStatePanel's
// LastDecision layout for the bar the user is hovering, with a
// drill-down sub-list when the block is at the algo layer (so the
// user sees WHICH of the six XovdGate values fired).
// Positioned next to the crosshair point, edge-clamped to wrap.
const GATE_HOVER_LAYERS = ['infrastructure', 'session', 'algo', 'trading'];

// XovdGate enum (algobot/strategy/xovdV1.h). Index = enum value,
// order = priority. Edit here when the runner-side enum changes.
const XOVD_GATE_NAMES = [
  'None',              // 0 — not used as a fail value
  'StateNotEligible',  // 1
  'Cooldown',          // 2
  'BarsAfterCross',    // 3
  'BarsOnSide',        // 4
  'Proximity',         // 5
  'Geometry',          // 6
];

function GateHoverTip({ x, y, decision, wrapRef }) {
  const wrap = wrapRef.current;
  const wrapW = wrap?.clientWidth  || 0;
  const wrapH = wrap?.clientHeight || 0;
  const isAlgoBlocked = decision.blocked_layer === 'algo';
  const x_ = decision.xovd || {};
  const hasContrib = x_.dist_raw_primary !== undefined
                  || x_.too_far_band !== undefined
                  || x_.atr_for_proximity !== undefined;
  const W = 280;
  // Tooltip grows when we drill into the algo sub-list (6 extra rows)
  // and again when contributors are bundled.
  let H = 130;
  if (isAlgoBlocked) H += 110;
  if (hasContrib)    H += 200;
  // Default: above-right of cursor. Flip if it would overflow.
  let left = x + 14;
  let top  = y - H - 14;
  if (left + W > wrapW) left = x - W - 14;
  if (top < 0)          top  = y + 14;
  if (top + H > wrapH)  top  = Math.max(0, wrapH - H - 2);
  // When nothing blocked (order placed), pretend blockedIdx is
  // past-end so all four layers render as ✓ rather than muted '·'.
  const rawIdx = GATE_HOVER_LAYERS.indexOf(decision.blocked_layer);
  const blockedIdx = (rawIdx < 0) ? GATE_HOVER_LAYERS.length : rawIdx;
  const failGate = decision[`${decision.blocked_layer}_gate`];
  // Display value for the failing gate header: if algo, decode to name.
  const failDisplay = isAlgoBlocked
    ? (XOVD_GATE_NAMES[failGate] ?? failGate)
    : (failGate ?? '');
  return (
    <div
      className="absolute z-30 pointer-events-none rounded border border-border bg-panel/95 shadow-lg text-xs tnum"
      style={{ left, top, width: W }}
    >
      <div className="px-2 py-1 border-b border-border bg-bg/40 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted">gates</span>
        <span className="text-text text-[10px]">bar #{decision.bar_idx}</span>
      </div>
      <div className="px-2 py-1 space-y-0">
        {GATE_HOVER_LAYERS.map((layer, i) => {
          const passed = i < blockedIdx;
          const isFailing = i === blockedIdx;
          const skipped = i > blockedIdx;
          let icon, cls, detail = '';
          if (skipped)        { icon = '·'; cls = 'text-muted/40'; }
          else if (isFailing) { icon = '⊘'; cls = 'text-short';    detail = failDisplay; }
          else if (passed)    { icon = '✓'; cls = 'text-long';     }
          else                { icon = '·'; cls = 'text-muted';    }
          return (
            <div key={layer} className="flex items-baseline gap-2 leading-tight">
              <span className={`${cls} w-3 text-center`}>{icon}</span>
              <span className={`${cls} w-24`}>{layer}</span>
              <span className="text-muted truncate text-[11px]">{detail}</span>
            </div>
          );
        })}
        {isAlgoBlocked && (
          <div className="mt-1 pt-1 border-t border-border/60">
            <div className="text-[10px] uppercase tracking-wide text-muted mb-0.5">algo gates</div>
            {XOVD_GATE_NAMES.slice(1).map((name, idx) => {
              const enumVal = idx + 1;
              const passed = enumVal < failGate;
              const isFailing = enumVal === failGate;
              const skipped = enumVal > failGate;
              let icon, cls;
              if (skipped)        { icon = '·'; cls = 'text-muted/40'; }
              else if (isFailing) { icon = '⊘'; cls = 'text-short';    }
              else if (passed)    { icon = '✓'; cls = 'text-long';     }
              else                { icon = '·'; cls = 'text-muted';    }
              return (
                <div key={name} className="flex items-baseline gap-2 leading-tight pl-2">
                  <span className={`${cls} w-3 text-center`}>{icon}</span>
                  <span className={`${cls}`}>{name}</span>
                </div>
              );
            })}
          </div>
        )}
        {hasContrib && (
          <div className="mt-1 pt-1 border-t border-border/60">
            <div className="text-[10px] uppercase tracking-wide text-muted mb-0.5">contributors</div>
            <ContribRow k="state"          v={x_.state} />
            <ContribRow k="close"          v={fmt(x_.close, 2)} />
            <ContribRow k="prev_close"     v={fmt(x_.prev_close, 2)} />
            <ContribRow k="fast_ma"        v={fmt(x_.fast_ma, 4)} />
            <ContribRow k="slow_ma"        v={fmt(x_.slow_ma, 4)} />
            <ContribRow k="atr"            v={fmt(x_.atr, 4)} />
            <ContribRow k="entry_limit"    v={fmt(decision.entry_limit, 2)} />
            <ContribRow k="dist_raw"       v={fmt(x_.dist_raw_primary, 4)} />
            <ContribRow k="dist_clamp"     v={CLAMP_NAMES[x_.dist_clamp_primary] ?? x_.dist_clamp_primary} />
            <ContribRow k="too_far_band"   v={fmt(x_.too_far_band, 4)} />
            <ContribRow k="atr_for_prox"   v={fmt(x_.atr_for_proximity, 4)} />
            <ContribRow k="bars_above_long" v={x_.bars_above_long} />
            <ContribRow k="bars_above_short" v={x_.bars_above_short} />
            <ContribRow k="bars_below_long" v={x_.bars_below_long} />
            <ContribRow k="bars_below_short" v={x_.bars_below_short} />
            <ContribRow k="bars_after_x_up" v={x_.bars_after_x_up} />
            <ContribRow k="bars_after_x_dn" v={x_.bars_after_x_dn} />
          </div>
        )}
      </div>
    </div>
  );
}

// dist_clamp_* enum (from algobot/strategy/xovdV1.h). 0 = none, 1 = buffer
// floor, 2 = ema-cap. Names rendered straight, no derivation.
const CLAMP_NAMES = ['none', 'buffer', 'ema-cap'];

function ContribRow({ k, v }) {
  return (
    <div className="flex items-baseline gap-2 leading-tight">
      <span className="text-muted text-[11px] w-32">{k}</span>
      <span className="text-text text-[11px]">{v ?? '—'}</span>
    </div>
  );
}

// Light formatter: numbers to fixed precision; pass-through everything else.
function fmt(v, dp) {
  if (v == null) return null;
  if (typeof v !== 'number') return v;
  return v.toFixed(dp);
}

function BarCloseCountdown({ periodSec }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sec = Math.floor(now / 1000);
  const nextClose = (Math.floor(sec / periodSec) + 1) * periodSec;
  const remaining = nextClose - sec;
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const stale = remaining > periodSec - 1;   // never happens unless clock skew
  return (
    <span className={`${remaining < 10 ? 'text-trail' : 'text-text'} font-semibold`}>
      next bar {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

function aggregateBars(bars, periodSec) {
  if (periodSec <= 180) return bars;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.ts_ns / 1e9 / periodSec) * periodSec;
    if (!cur || cur.bucket !== bucket) {
      if (cur) out.push(cur);
      cur = {
        bucket,
        ts_ns: bucket * 1e9,
        open: b.open, high: b.high, low: b.low, close: b.close,
        fast_ma: b.fast_ma, slow_ma: b.slow_ma, atr: b.atr,
      };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low  = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.fast_ma = b.fast_ma;
      cur.slow_ma = b.slow_ma;
      cur.atr = b.atr;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function dedupeByTime(arr) {
  if (arr.length === 0) return arr;
  const out = [];
  for (const x of arr) {
    if (out.length && out[out.length - 1].time === x.time) {
      out[out.length - 1] = x;
    } else {
      out.push(x);
    }
  }
  return out;
}

const BLOCK_LAYER_COLORS = {
  infrastructure: '#6b7280',
  session:        '#7c8190',
  algo:           '#ef5350',
  trading:        '#ffb300',
};

function drawOverlay(chart, candles, canvas, wrap, data, tf, selectedTradeKey) {
  if (!chart || !candles || !canvas || !wrap || !data) return null;
  const dpr = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth;
  const cssH = wrap.clientHeight;
  if (canvas.width  !== cssW * dpr) canvas.width  = cssW * dpr;
  if (canvas.height !== cssH * dpr) canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const ts = chart.timeScale();
  const snap = (t) => Math.floor(t / tf) * tf;
  // Inactive-session shading goes UNDER everything else (drawn first
  // so candles + MAs + markers paint over it).
  drawSessionShading(ctx, chart, canvas, data, tf);
  drawLimitLine(ctx, chart, candles, data, tf, snap);
  // Slow-EMA-anchored "what-if" limit line. No-op when the runner
  // isn't emitting entry_limit_slow yet (engine-claude ask filed in
  // devstream.md 2026-05-12). When it arrives, this draws a dashed,
  // dimmed line alongside the primary so "we're in slow-anchor zone
  // but slow path isn't firing" becomes visible at a glance.
  drawLimitLineSlow(ctx, chart, candles, data, tf, snap);

  // Bars cover (typically) just today — broker_truth is the FULL account
  // history, possibly weeks/months. Restrict to trades whose entry sits
  // within the loaded bar range, so the off-screen historical pile doesn't
  // tank the "drawn/total" ratio (and so we know what the user can act on).
  const bars = data.bars || [];
  const broker = data.broker || [];
  let inRange = broker;
  let outOfRange = 0;
  if (bars.length) {
    const firstNs = bars[0].ts_ns;
    const lastNs  = bars[bars.length - 1].ts_ns + tf * 1e9;
    inRange = broker.filter(t => t.entry_ts >= firstNs && t.entry_ts < lastNs);
    outOfRange = broker.length - inRange.length;
  }

  // Sub-bar X-coord for an event whose timestamp falls inside bar X.
  // lightweight-charts renders each bar's body CENTERED on its
  // time-coordinate (= timeToCoordinate(bar.ts)), so bar X visually
  // occupies [xL - barWidth/2, xL + barWidth/2] where barWidth =
  // (xR - xL) is the gap between consecutive bar centers.
  //
  // Two failure modes to dodge:
  //   - alpha=0 mapped to xL - barWidth/2 (the literal left edge)
  //     puts the marker on the boundary line between bar X-1 and
  //     bar X -- reads as the previous bar (the original "off-by-
  //     one symptom" the prior version was fixing).
  //   - alpha=1 mapped to xL + barWidth/2 (literal right edge) /
  //     OR worse to the next bar's center (the prior version's
  //     bug) -- a trade that fired in the last second of bar X
  //     would visually land on bar X+1.
  //
  // Compromise: 10% inset from each edge. alpha 0..1 maps to
  // [xL - 0.4*barWidth, xL + 0.4*barWidth] -- always visually
  // INSIDE the bar the event fired in, with enough air at each
  // edge to read unambiguously.
  const subBarX = (tsNs) => {
    const tSec = tsNs / 1e9;
    const tBar = snap(tSec);
    const xL = ts.timeToCoordinate(tBar);
    if (xL == null) return null;
    const xR = ts.timeToCoordinate(tBar + tf);
    if (xR == null) return xL;
    const alpha = (tSec - tBar) / tf;
    const barWidth = xR - xL;
    return xL + (alpha - 0.5) * 0.8 * barWidth;
  };

  // Two layers of triangles, drawn back-to-front:
  //   - data.broker (solid): real broker fills (relay-pulled in live;
  //     sim fills in historical replay where broker == trades). These
  //     are the ground truth for what actually executed.
  //   - data.trades (hollow): algo-sim fills the runner emitted. When
  //     algo + broker pair within MATCH_AHEAD_NS the hollow stacks on
  //     the solid (matched fill); when they diverge horizontally the
  //     gap = slip; when one is missing the asymmetry shows missed POSTs
  //     or manual broker entries.
  //
  // Sub-bar positioning via subBarX(): both timestamps land at the
  // simulator's booked / broker's executed instant, not the bar center.
  let drawn = 0;
  for (const t of inRange) {
    const isLong = t.side === 'long';
    const entryColor = isLong ? '#1976d2' : '#ffff00';
    const exitColor  = t.pnl > 0 ? '#7fff00' : '#ef5350';
    const xIn  = subBarX(t.entry_ts);
    const yIn  = candles.priceToCoordinate(t.entry_px);
    const isSel = selectedTradeKey === t.entry_ts;
    if (xIn != null && yIn != null) {
      drawArrow(ctx, xIn, yIn, entryColor, 'right', isSel);
      drawn++;
    }
    if (t.exit_ts && t.exit_px != null) {
      const xOut = subBarX(t.exit_ts);
      const yOut = candles.priceToCoordinate(t.exit_px);
      if (xOut != null && yOut != null) {
        drawArrow(ctx, xOut, yOut, exitColor, 'left', isSel);
        drawn++;
      }
    }
  }
  // Algo-sim layer — hollow triangles overlaid on the broker layer.
  // Same in-range filter so off-window algos don't pile up.
  const algos = data.trades || [];
  const inRangeAlgos = bars.length
    ? algos.filter(t => t.entry_ts >= bars[0].ts_ns
                     && t.entry_ts < bars[bars.length - 1].ts_ns + tf * 1e9)
    : algos;
  for (const t of inRangeAlgos) {
    const isLong = t.side === 'long';
    const entryColor = isLong ? '#1976d2' : '#ffff00';
    const exitColor  = (t.pnl ?? 0) > 0 ? '#7fff00' : '#ef5350';
    const xIn  = subBarX(t.entry_ts);
    const yIn  = candles.priceToCoordinate(t.entry_px);
    if (xIn != null && yIn != null) {
      drawArrow(ctx, xIn, yIn, entryColor, 'right', false, /*hollow*/ true);
    }
    if (t.exit_ts && t.exit_px != null) {
      const xOut = subBarX(t.exit_ts);
      const yOut = candles.priceToCoordinate(t.exit_px);
      if (xOut != null && yOut != null) {
        drawArrow(ctx, xOut, yOut, exitColor, 'left', false, /*hollow*/ true);
      }
    }
  }
  return { drawn, total: inRange.length * 2, outOfRange };
}

// Per-bar entry-limit trail. Direction-coded (cyan long, yellow short)
// with intensity by outcome:
//   bright = order placed (or fully un-blocked)
//   dim    = computed but blocked by an algo-layer gate other than
//            Proximity (cooldown, bars-after-cross, bars-on-side,
//            geometry) OR by a trading-layer gate (max trades, hedge,
//            slots full, sizing zero)
//   hidden = infra-blocked, session-blocked, or Proximity-blocked
//            ("too far away"). Per user 2026-05-12: if the price is
//            too far from the would-be entry, drawing the line is
//            noise — the strategy isn't shopping a limit anywhere near
//            actionable territory.
// Point-to-point (no smoothing) so each bar's value is legible.
const LIMIT_COLORS = {
  long_bright:  '#05FEFF',                       // bright cyan
  long_dim:     'rgba(5,254,255,0.45)',
  short_bright: '#ffff00',                       // bright yellow
  short_dim:    'rgba(255,255,0,0.45)',
};

// XovdGate::Proximity (5) per algobot/strategy/xovdV1.h. Used to
// distinguish "too far away" (hide) from other algo-layer blocks
// (dim). If the gate enum is renumbered runner-side, also update here.
const ALGO_GATE_PROXIMITY = 5;

function classifyDecision(d) {
  if (d.is_warmup) return null;
  if (d.entry_limit == null || d.entry_limit <= 0) return null;
  // Hard hides: infra / session / proximity.
  if (d.blocked_layer === 'infrastructure') return null;
  if (d.blocked_layer === 'session') return null;
  if (d.blocked_layer === 'algo' && d.algo_gate === ALGO_GATE_PROXIMITY) return null;
  const isLong = d.xovd?.state === 'crossed_up';
  // Hide when the bar's close is on the wrong side of the fast EMA
  // for the limit's direction — the setup is obviously not active:
  //   long  expects close >= fast_ma (crossed up, pull-back to anchor)
  //   short expects close <= fast_ma (crossed down, push-up to anchor)
  // Falsy-data guard: only hide when both are present.
  const close = d.xovd?.close;
  const fMa   = d.xovd?.fast_ma;
  if (close != null && fMa != null) {
    if (isLong  && close < fMa) return null;
    if (!isLong && close > fMa) return null;
  }
  const blocked = d.blocked_layer && d.blocked_layer !== 'none';
  if (isLong) return blocked ? 'long_dim' : 'long_bright';
  return blocked ? 'short_dim' : 'short_bright';
}

// Translucent grey background over runs of bars where in_session=false
// (= the runner's session_gate is anything other than "none"). Drawn
// first so candles/MAs/markers overlay it cleanly. Each contiguous
// run renders as one rect spanning [first_bar_left_edge,
// last_bar_right_edge] x full chart height.
function drawSessionShading(ctx, chart, canvas, data, tf) {
  const bars = data?.bars;
  if (!bars || !bars.length) return;
  const ts = chart.timeScale();
  const cssH = canvas.clientHeight;
  // Half-bar visual width on each side of the bar's center.
  const halfBarPx = (() => {
    const b = bars[0];
    const xL = ts.timeToCoordinate(Math.floor(b.ts_ns / 1e9));
    const xR = ts.timeToCoordinate(Math.floor(b.ts_ns / 1e9) + tf);
    if (xL == null || xR == null) return 0;
    return (xR - xL) / 2;
  })();
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  let runStart = null;   // x-pixel of left edge of the first bar in the run
  let runEnd = null;     // x-pixel of right edge of the last bar in the run
  const flush = () => {
    if (runStart != null && runEnd != null && runEnd > runStart) {
      ctx.fillRect(runStart, 0, runEnd - runStart, cssH);
    }
    runStart = runEnd = null;
  };
  for (const b of bars) {
    if (b.in_session === false) {
      const x = ts.timeToCoordinate(Math.floor(b.ts_ns / 1e9));
      if (x == null) continue;
      const left = x - halfBarPx;
      const right = x + halfBarPx;
      if (runStart == null) {
        runStart = left;
        runEnd = right;
      } else {
        runEnd = right;
      }
    } else {
      flush();
    }
  }
  flush();
}

function drawLimitLine(ctx, chart, candles, data, tf, snap) {
  if (!data?.decisions?.length) return;
  const ts = chart.timeScale();
  ctx.lineWidth = 3;
  ctx.lineCap = 'butt';
  // Each decision draws an INDEPENDENT horizontal segment at its
  // `entry_limit` price, spanning the column of bar X+1 (the bar the
  // limit applies to). No connecting diagonals between bars — the
  // limit can move arbitrarily bar-to-bar and a diagonal misleads.
  // Segment span: from the gap before bar X+1 (midpoint of bar X / X+1
  // centers) to the gap after bar X+1 (midpoint of bar X+1 / X+2
  // centers). v5 timeToCoordinate is bar-aligned-only, so we look up
  // three neighbouring bar centers and average pairwise to get the
  // two gap positions.
  for (const d of data.decisions) {
    const inTrade = (d.open_qty || 0) !== 0;
    const cls = inTrade ? null : classifyDecision(d);
    if (cls == null) continue;
    const t = Math.floor(d.ts_ns / 1e9);
    const xPrev = ts.timeToCoordinate(snap(t) - tf);  // bar X center
    const xMid  = ts.timeToCoordinate(snap(t));        // bar X+1 center
    const xNext = ts.timeToCoordinate(snap(t) + tf);   // bar X+2 center
    if (xMid == null) continue;
    // Fall back to xMid when an edge neighbour isn't loaded yet so
    // the leftmost / rightmost bar still renders a (half-width) segment.
    const xLeft  = (xPrev == null) ? xMid : (xPrev + xMid) / 2;
    const xRight = (xNext == null) ? xMid : (xMid + xNext) / 2;
    const y = candles.priceToCoordinate(d.entry_limit);
    if (y == null) continue;
    ctx.strokeStyle = LIMIT_COLORS[cls] || LIMIT_COLORS.none;
    ctx.beginPath();
    ctx.moveTo(xLeft,  y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
}

// Slow-EMA-anchored variant of the primary limit line. Reads
// `d.xovd.entry_limit_slow` (engine-claude commit 2026-05-12 puts it
// inside the xovd subobject alongside fast_ma/slow_ma/atr).
// Visual treatment: dashed, same direction-coded hue as the primary,
// reduced opacity so it reads as the "alternative / what-if" overlay.
// Same gating logic as the primary (bright/dim/hidden by gate).
const LIMIT_COLORS_SLOW = {
  long_bright:  'rgba(5,254,255,0.75)',
  long_dim:     'rgba(5,254,255,0.30)',
  short_bright: 'rgba(255,255,0,0.75)',
  short_dim:    'rgba(255,255,0,0.30)',
};

function classifyDecisionSlow(d) {
  if (d.is_warmup) return null;
  const slowLimit = d.xovd?.entry_limit_slow;
  if (slowLimit == null || slowLimit <= 0) return null;
  if (d.blocked_layer === 'infrastructure') return null;
  if (d.blocked_layer === 'session') return null;
  if (d.blocked_layer === 'algo' && d.algo_gate === ALGO_GATE_PROXIMITY) return null;
  const isLong = d.xovd?.state === 'crossed_up';
  // Same wrong-side-of-fast-EMA hide as the primary — see classifyDecision.
  const close = d.xovd?.close;
  const fMa   = d.xovd?.fast_ma;
  if (close != null && fMa != null) {
    if (isLong  && close < fMa) return null;
    if (!isLong && close > fMa) return null;
  }
  const blocked = d.blocked_layer && d.blocked_layer !== 'none';
  if (isLong) return blocked ? 'long_dim' : 'long_bright';
  return blocked ? 'short_dim' : 'short_bright';
}

function drawLimitLineSlow(ctx, chart, candles, data, tf, snap) {
  if (!data?.decisions?.length) return;
  const ts = chart.timeScale();
  ctx.save();
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';
  ctx.setLineDash([5, 4]);
  // Per-bar horizontal segments, same layout as the primary — see
  // drawLimitLine. Stays dashed/dim so it reads as the "what-if".
  for (const d of data.decisions) {
    const inTrade = (d.open_qty || 0) !== 0;
    const cls = inTrade ? null : classifyDecisionSlow(d);
    if (cls == null) continue;
    const t = Math.floor(d.ts_ns / 1e9);
    const xPrev = ts.timeToCoordinate(snap(t) - tf);
    const xMid  = ts.timeToCoordinate(snap(t));
    const xNext = ts.timeToCoordinate(snap(t) + tf);
    if (xMid == null) continue;
    const xLeft  = (xPrev == null) ? xMid : (xPrev + xMid) / 2;
    const xRight = (xNext == null) ? xMid : (xMid + xNext) / 2;
    const y = candles.priceToCoordinate(d.xovd.entry_limit_slow);
    if (y == null) continue;
    ctx.strokeStyle = LIMIT_COLORS_SLOW[cls];
    ctx.beginPath();
    ctx.moveTo(xLeft,  y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBlockMarkers(ctx, chart, candles, data, tf, snap) {
  if (!data?.decisions) return;
  for (const d of data.decisions) {
    if (d.is_warmup) continue;
    if (!d.blocked_layer || d.blocked_layer === 'none') continue;
    if (d.order_placed >= 0) continue;
    const color = BLOCK_LAYER_COLORS[d.blocked_layer];
    if (!color) continue;
    // Place dot at the would-be limit price when the strategy computed
    // one (entry_limit > 0). Otherwise fall back to bar close. This
    // makes the dot meaningful — "here's where the order would have
    // sat" — instead of just "a block happened on this bar".
    const px = (d.entry_limit && d.entry_limit > 0) ? d.entry_limit : d.xovd?.close;
    if (px == null) continue;
    const t = Math.floor(d.ts_ns / 1e9);
    // Same boundary positioning as the limit lines — the block is a
    // decision taken at bar X close, applying to bar X+1; sit in the
    // gap between them by averaging the two neighbouring bar centers.
    const tsScale = chart.timeScale();
    const xR = tsScale.timeToCoordinate(snap(t));
    const xL = tsScale.timeToCoordinate(snap(t) - tf);
    if (xR == null || xL == null) continue;
    const x = (xL + xR) / 2;
    const y = candles.priceToCoordinate(px);
    if (y == null) continue;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;
}

function drawArrow(ctx, x, y, color, dir, highlighted, hollow = false) {
  const len = highlighted ? 22 : 16;
  const h   = highlighted ? 12 : 8;
  // Halo first — translucent dark backing makes the arrow pop against
  // bright candles. Drawn slightly larger than the fill. Skip for the
  // hollow variant: the colored stroke against the candles is enough,
  // and a dark halo would obscure the see-through middle that's the
  // whole point of hollow.
  if (!hollow) {
    ctx.beginPath();
    if (dir === 'right') {
      ctx.moveTo(x + 2,    y);
      ctx.lineTo(x - len - 2, y - h - 2);
      ctx.lineTo(x - len - 2, y + h + 2);
    } else {
      ctx.moveTo(x - 2,    y);
      ctx.lineTo(x + len + 2, y - h - 2);
      ctx.lineTo(x + len + 2, y + h + 2);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fill();
  }
  // Body — filled triangle for broker-truth fills, stroke-only for
  // algo-sim. Stack matched pairs (same color, same position) overlay
  // cleanly; mismatches separate horizontally / one side missing.
  ctx.beginPath();
  if (dir === 'right') {
    ctx.moveTo(x, y);
    ctx.lineTo(x - len, y - h);
    ctx.lineTo(x - len, y + h);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y - h);
    ctx.lineTo(x + len, y + h);
  }
  ctx.closePath();
  if (hollow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
  if (highlighted) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
