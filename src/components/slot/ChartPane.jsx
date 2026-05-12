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

const TF_OPTIONS = [
  { sec: 180, label: 'M3' },
  { sec: 900, label: 'M15' },
  { sec: 1800, label: 'M30' },
  { sec: 3600, label: 'H1' },
];

export default function ChartPane({ data, tf, setTf, selectedTradeKey, setSelectedTradeKey, runnerId }) {
  const wrapRef = useRef(null);
  const chartDivRef = useRef(null);
  const overlayRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const lastBarRef = useRef(null);   // last bar ref-eq pushed to chart
  const restoredRef = useRef(false);  // have we restored saved view yet?

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
        // KEY: when a new bar arrives via chart.update(), do NOT auto-
        // shift the visible range. User's pan/zoom stays anchored.
        shiftVisibleRangeOnNewBar: false,
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
    const fastMa = chart.addSeries(LineSeries, { color: '#E040FB', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const slowMa = chart.addSeries(LineSeries, { color: '#2962FF', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });

    // Click-on-candle -> find nearest broker trade. First exact bar match,
    // then nearest-in-time within a couple of bar widths so the user
    // doesn't have to land exactly on the entry candle.
    chart.subscribeClick((param) => {
      if (!param?.time) return;
      const broker = currentBrokerRef.current;
      if (!broker?.length) return;
      const tfNow = currentTfRef.current;
      const clickSec = Number(param.time);
      let best = null, bestDist = Infinity;
      for (const t of broker) {
        const e = Math.floor(t.entry_ts / 1e9);
        const d = Math.abs(e - clickSec);
        if (d < bestDist) { bestDist = d; best = t; }
      }
      // Tolerance = 4 bars either side. Beyond that the click was
      // probably about something else.
      if (best && bestDist <= tfNow * 4) {
        setSelectedTradeKeyRef.current(best.entry_ts);
      }
    });

    chartRef.current = chart;
    seriesRef.current = { candles, fastMa, slowMa };

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
      chart.remove();
      chartRef.current = null;
      lastBarRef.current = null;
      restoredRef.current = false;
    };
  }, []);

  // runnerId ref so the listener (set up at mount) reads the latest value.
  const currentRunnerIdRef = useRef(runnerId);
  useEffect(() => { currentRunnerIdRef.current = runnerId; }, [runnerId]);

  // Refs for click handler so we don't recreate the chart when broker
  // / tf / setSelectedTradeKey change.
  const currentBrokerRef = useRef(data?.broker || []);
  const currentTfRef = useRef(tf);
  const setSelectedTradeKeyRef = useRef(setSelectedTradeKey);
  useEffect(() => { currentBrokerRef.current = data?.broker || []; }, [data?.broker]);
  useEffect(() => { currentTfRef.current = tf; }, [tf]);
  useEffect(() => { setSelectedTradeKeyRef.current = setSelectedTradeKey; }, [setSelectedTradeKey]);

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
  const dataForPanRef = useRef(data);
  useEffect(() => { dataForPanRef.current = data; }, [data]);
  useEffect(() => {
    if (!chartRef.current || selectedTradeKey == null) return;
    const d = dataForPanRef.current;
    if (!d) return;
    const t = d.broker.find(t => t.entry_ts === selectedTradeKey);
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
      {/* TF picker + fit button — bottom-left, just above the time
          gutter, mirroring the TradingView toolbar layout. `left-10`
          clears the lightweight-charts "TV" watermark logo. */}
      <div className="absolute bottom-7 left-10 z-20 flex gap-1 text-[11px]">
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
      <div className="absolute top-2 right-2 z-10 px-2 py-0.5 rounded bg-panel/90 border border-border text-[10px] text-muted tnum flex items-center gap-3">
        <BarCloseCountdown periodSec={tf} />
        <span className="opacity-60">
          broker {data?.broker?.length || 0} · markers {markerStats.drawn}/{markerStats.total}
          {markerStats.outOfRange > 0 && <> · <span className="text-trail">{markerStats.outOfRange} off-range</span></>}
        </span>
      </div>
      <div ref={chartDivRef} className="absolute inset-0" />
      {/* z-index 10: lightweight-charts creates an internal stacking
          context with its own canvases. Without explicit z-index here
          the overlay can render BELOW the candle layer. (Same trick as
          strategy-visualizer/index.html #overlay.) */}
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }} />
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
  drawLimitLine(ctx, chart, candles, data, tf, snap);

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

  // Trade markers from BROKER (real fills), not the sparse sim deriv.
  let drawn = 0;
  for (const t of inRange) {
    const isLong = t.side === 'long';
    const entryColor = isLong ? '#1976d2' : '#ffff00';
    const exitColor  = t.pnl > 0 ? '#7fff00' : '#ef5350';
    const xIn  = ts.timeToCoordinate(snap(Math.floor(t.entry_ts / 1e9)));
    const yIn  = candles.priceToCoordinate(t.entry_px);
    const isSel = selectedTradeKey === t.entry_ts;
    if (xIn != null && yIn != null) {
      drawArrow(ctx, xIn, yIn, entryColor, 'right', isSel);
      drawn++;
    }
    if (t.exit_ts && t.exit_px != null) {
      const xOut = ts.timeToCoordinate(snap(Math.floor(t.exit_ts / 1e9)));
      const yOut = candles.priceToCoordinate(t.exit_px);
      if (xOut != null && yOut != null) {
        drawArrow(ctx, xOut, yOut, exitColor, 'left', isSel);
        drawn++;
      }
    }
  }
  return { drawn, total: inRange.length * 2, outOfRange };
}

// Per-bar entry-limit trail. Visual feedback for the maxAtr/dist/buffer
// param combo: shows where the strategy WOULD have parked the limit
// each bar. Segments colored by outcome at the bar's CLOSE:
//   sent long  -> cyan
//   sent short -> yellow
//   blocked    -> red
//   no signal  -> grey (dim, ambient)
// Point-to-point (no smoothing) — the user wants to see the exact step
// shape so the params' effect is legible.
const LIMIT_COLORS = {
  long_sent:  '#06b6d4',   // cyan
  short_sent: '#facc15',   // yellow
  blocked:    '#ef5350',   // red
  none:       'rgba(124,129,144,0.35)',  // dim grey, ambient
};

function classifyDecision(d) {
  if (d.is_warmup) return null;
  if (d.entry_limit == null || d.entry_limit <= 0) return null;
  // Side comes from xovd.state: crossed_up = long-bias, crossed_down = short.
  // Independent of blocked/sent — a blocked LONG should still color red,
  // but knowing the side lets the user-side legend stay correct if we
  // ever surface it.
  const isLong = d.xovd?.state === 'crossed_up';
  if (d.blocked_layer && d.blocked_layer !== 'none') return 'blocked';
  if (d.order_placed >= 0) return isLong ? 'long_sent' : 'short_sent';
  return 'none';
}

function drawLimitLine(ctx, chart, candles, data, tf, snap) {
  if (!data?.decisions?.length) return;
  const ts = chart.timeScale();
  ctx.lineWidth = 1.5;
  // Walk decisions in order. Two break conditions reset `prev` so we
  // don't bridge a segment across them:
  //   1. The bar didn't compute a limit (cls == null), OR
  //   2. We're in a position (open_qty != 0) — the strategy isn't
  //      shopping a new limit, so the line shouldn't span the trade.
  let prev = null;
  for (const d of data.decisions) {
    const inTrade = (d.open_qty || 0) !== 0;
    const cls = inTrade ? null : classifyDecision(d);
    if (cls == null) { prev = null; continue; }
    const t = Math.floor(d.ts_ns / 1e9);
    const x = ts.timeToCoordinate(snap(t));
    if (x == null) { prev = null; continue; }
    const y = candles.priceToCoordinate(d.entry_limit);
    if (y == null) { prev = null; continue; }
    if (prev) {
      ctx.strokeStyle = LIMIT_COLORS[cls] || LIMIT_COLORS.none;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    prev = { x, y };
  }
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
    const x = chart.timeScale().timeToCoordinate(snap(t));
    if (x == null) continue;
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

function drawArrow(ctx, x, y, color, dir, highlighted) {
  const len = highlighted ? 22 : 16;
  const h   = highlighted ? 12 : 8;
  // Halo first — translucent dark backing makes the arrow pop against
  // bright candles. Drawn slightly larger than the fill.
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
  // Colored fill on top
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
  ctx.fillStyle = color;
  ctx.fill();
  if (highlighted) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
