// Per-trade tick-level modal. Lifted layout from the strategy-
// visualizer playground screenshot.
//
// Sources:
//   - broker: real fills (entry/exit/qty/pnl). Always present.
//   - decision: matched by entry-bar bar_idx for SL/TP/TS derivation.
//                Optional — modal still renders without it.
//   - ticks:   GET /tick_history?from_ns&to_ns from coord's ring buffer.
//                Fall back to "out of window" message if older than the
//                buffer's oldest entry.

import { useEffect, useMemo, useRef, useState } from 'react';
import { redactSecrets } from '../../data/redact';

const COORD   = import.meta.env.VITE_ALGO_COORD_URL?.replace(/\/+$/, '') || '';
const ARCHIVE = import.meta.env.VITE_TICK_ARCHIVE_URL?.replace(/\/+$/, '') || '';
const TICK = 0.25;
const PRE_PAD_NS  =  5 * 1_000_000_000;   // 5 s before entry
const POST_PAD_NS =  5 * 1_000_000_000;   // 5 s after exit

function parseTickNdjson(text) {
  const arr = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { arr.push(JSON.parse(s)); } catch {}
  }
  return arr;
}

// Module-level LRU cache for fetched tick windows. Lives for the page
// session (cleared on hard refresh / dev-server bounce). Keyed by
// `${fromNs}-${toNs}` since both sides of a window are fixed-once-trade-
// is-closed. Values: { ticks: [...], source: 'coord' | 'archive' }.
//
// Why module-level: TradeTickModal mounts/unmounts every time the user
// opens/closes the modal — instance state is lost. Per-trade cache
// here means re-opening the same (or prev/next-navigated) trade is
// instant: no coord round-trip, no DBN decompression, no JSON re-decode.
//
// Cap chosen for ~80 MB worst case (20 entries × ~4 MB for a 50k-tick
// trade window). Drop the cap if the page starts feeling heavy; LRU
// eviction handles bound enforcement either way.
const TICK_CACHE = new Map();
const TICK_CACHE_MAX = 20;

function tickCacheGet(key) {
  if (!TICK_CACHE.has(key)) return null;
  // Touch — move to MRU position.
  const v = TICK_CACHE.get(key);
  TICK_CACHE.delete(key);
  TICK_CACHE.set(key, v);
  return v;
}

function tickCacheSet(key, value) {
  if (TICK_CACHE.has(key)) TICK_CACHE.delete(key);
  TICK_CACHE.set(key, value);
  while (TICK_CACHE.size > TICK_CACHE_MAX) {
    const firstKey = TICK_CACHE.keys().next().value;
    TICK_CACHE.delete(firstKey);
  }
}

export default function TradeTickModal({ trade, brokerTrade, algoTrade, decision, audit, onClose, onPrev, onNext }) {
  // `trade` = focal (= the one the user clicked). brokerTrade /
  // algoTrade may each be the same as focal, the sibling found by
  // side+qty pairing, or null (algo-only trade with no broker fill,
  // or vice-versa). Tick window range comes from focal; broker/algo
  // markers + summary rows come from their respective props.
  const [ticks, setTicks] = useState(null);   // null = loading, [] = no data, [...] = ok
  const [err, setErr] = useState(null);
  const [source, setSource] = useState(null); // 'coord' | 'archive' | null

  // Tick window:
  //   real trade: [entry-5s, exit+5s] (or [entry-5s, entry+5s] when
  //                still open). Anchored on the trade so the modal
  //                opens centered on the action.
  //   ad-hoc bar click: bar_open ± 30s + a 3-min bar's worth of right-
  //                pad. Wider so the operator gets a meaningful chunk
  //                of price action around the bar they clicked.
  // Then a min-span clamp: short scalps (~1-5s) used to open onto a
  // ~10s window, which (a) showed almost no context and (b) sat
  // below the 30s trade-print gate so dots were always hidden. Pad
  // symmetrically out to MIN_SPAN_NS so the operator opens onto
  // enough air around the trade to see what was happening.
  const MIN_SPAN_NS = 40 * 1_000_000_000;
  const adHocAnchor = trade?.ad_hoc;
  let fromNs = adHocAnchor
    ? trade.entry_ts - 30 * 1_000_000_000
    : (trade?.entry_ts ? trade.entry_ts - PRE_PAD_NS : 0);
  let toNs = adHocAnchor
    ? trade.entry_ts + 210 * 1_000_000_000
    : (trade?.exit_ts ? trade.exit_ts + POST_PAD_NS : (trade?.entry_ts || 0) + PRE_PAD_NS);
  if (toNs - fromNs < MIN_SPAN_NS) {
    const pad = (MIN_SPAN_NS - (toNs - fromNs)) / 2;
    fromNs -= pad;
    toNs += pad;
  }

  useEffect(() => {
    if (!trade) return;
    const cacheKey = `${fromNs}-${toNs}`;

    // Cache hit: serve instantly, no fetch. Set source to a "cached"
    // variant of the original so the badge stays accurate.
    const cached = tickCacheGet(cacheKey);
    if (cached) {
      setErr(null);
      setSource(cached.source);
      setTicks(cached.ticks);
      return;
    }

    let cancelled = false;
    setTicks(null);
    setErr(null);
    setSource(null);
    if (!COORD) {
      setErr("mock mode: no tick source");
      setTicks([]);
      return;
    }
    // Tier 1: archive sidecar (DBN files, includes BOTH quotes AND
    // trade prints from MBP1 action='T' records). Coord's live ring
    // only sees the upstream's bid/ask CSV (no trades), so we'd lose
    // the tape coloration if we used coord first. Sidecar covers
    // anything older than the current incomplete UTC hour.
    const tryArchive = () => {
      if (!ARCHIVE) return Promise.resolve(null);
      setSource('archive-loading');
      return fetch(`${ARCHIVE}/tick_history?from_ns=${fromNs}&to_ns=${toNs}`)
        .then(r => r.text())
        .then(text => {
          if (cancelled) return null;
          const arr = parseTickNdjson(text);
          if (!arr.length) return null;
          setSource('archive');
          setTicks(arr);
          tickCacheSet(cacheKey, { ticks: arr, source: 'archive' });
          return arr;
        })
        .catch(e => { if (!cancelled) setErr(`archive: ${String(e)}`); return null; });
    };
    // Tier 2: coord's live ring (~4h, quotes only). Used when the
    // archive doesn't cover the window yet (sub-hour-old trades the
    // DBN file hasn't been written for).
    const tryCoord = () => {
      return fetch(`${COORD}/tick_history?from_ns=${fromNs}&to_ns=${toNs}`)
        .then(r => r.text())
        .then(text => {
          if (cancelled) return;
          const arr = parseTickNdjson(text);
          const src = arr.length > 0 ? 'coord' : null;
          setSource(src);
          setTicks(arr);
          if (arr.length > 0) {
            tickCacheSet(cacheKey, { ticks: arr, source: 'coord' });
          }
        })
        .catch(e => { if (!cancelled) { setErr(`coord: ${String(e)}`); setTicks([]); } });
    };
    tryArchive().then(arr => {
      if (cancelled || arr) return;
      return tryCoord();
    });
    return () => { cancelled = true; };
  }, [trade?.entry_ts, fromNs, toNs]);

  // Esc to close, ←/→ for prev/next.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === 'ArrowLeft' && onPrev) onPrev();
      else if (e.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);

  // Floating-panel position. Initial render uses transform centering
  // (no measurement needed -> no flash); the layout effect below
  // measures the panel once and converts to numeric left/top so the
  // drag handler can manipulate coords directly.
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (pos !== null) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(0, (window.innerWidth  - rect.width)  / 2),
      y: Math.max(0, (window.innerHeight - rect.height) / 2),
    });
  }, [pos]);

  // Drag-by-header. Header buttons opt out via closest('button') so
  // prev/next/close still fire normally. Position clamped so the
  // user can't fling it off-screen and lose the close button.
  const onHeaderMouseDown = (e) => {
    if (e.target.closest('button')) return;
    if (!pos) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startPos = { ...pos };
    const onMove = (ev) => {
      const el = panelRef.current;
      const w = el?.offsetWidth  || 0;
      const h = el?.offsetHeight || 0;
      setPos({
        x: clamp(startPos.x + (ev.clientX - startX), 8 - w + 80, window.innerWidth  - 80),
        y: clamp(startPos.y + (ev.clientY - startY), 0,          window.innerHeight - 40),
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  };

  if (!trade) return null;

  // Derive SL/TP/TS prices for chart bracket lines + summary KVs.
  // Ad-hoc mode = a chart-bar click on a bar with no trade. The
  // modal still opens (so the operator can inspect ticks for any
  // bar) but with all trade-anchored chrome suppressed -- ticks
  // are the only payload.
  //
  // Bracket source preference: algo decision > audit POST request.
  //   - decision (when available) carries the strategy's intended
  //     bracket in tick form -- cleanest source
  //   - audit fallback covers broker_only rows (no matching algo
  //     trade, e.g. cap-suppressed sim or relay-side reorder where
  //     the runner didn't emit). The audit IS the order placement,
  //     so its sl/tp/trail params reflect what the broker armed on.
  //   - neither = truly manual broker fill, no bracket lines drawn.
  // Broker fills don't carry bracket fields directly -- only orders
  // (audits) do -- so this is the only fallback path.
  //
  // Anchor price preference: algo entry_px > broker entry_px > focal.
  //   - algo entry_px = the limit price the order targeted = what the
  //     algo's intended SL is anchored on
  //   - broker entry_px = actual fill (slippage relative to algo)
  //   - focal = whichever the user clicked on
  // For broker_only trades, anchor falls through to broker entry_px.
  const adHoc = !!trade.ad_hoc;
  const isLong = trade.side === 'long';
  const dir = isLong ? 1 : -1;
  const bracketSrc = !adHoc && (decision || (audit?.request ? {
    sl_ticks:           Number(audit.request.stop_loss     ?? 0) || null,
    tp_ticks:           Number(audit.request.take_profit   ?? 0) || null,
    trail_trigger_ticks: Number(audit.request.trail_trigger ?? 0) || null,
    trail_dist_ticks:    Number(audit.request.trail_dist    ?? 0) || null,
  } : null));
  const anchorPx = algoTrade?.entry_px ?? brokerTrade?.entry_px ?? trade?.entry_px;
  const slPx = bracketSrc?.sl_ticks
    ? anchorPx - dir * bracketSrc.sl_ticks * TICK : null;
  const tpPx = bracketSrc?.tp_ticks
    ? anchorPx + dir * bracketSrc.tp_ticks * TICK : null;
  const tsPx = bracketSrc?.trail_trigger_ticks
    ? anchorPx + dir * bracketSrc.trail_trigger_ticks * TICK : null;

  return (
    <div
      ref={panelRef}
      className="fixed z-30 bg-panel border border-border rounded-md p-4 shadow-2xl max-w-5xl w-[90vw]"
      style={pos
        ? { left: pos.x, top: pos.y }
        : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
    >
        {/* Header (also the drag handle -- mousedown anywhere except
            the buttons starts a drag). */}
        <div
          className="flex items-center gap-3 mb-3 cursor-move select-none"
          onMouseDown={onHeaderMouseDown}
        >
          <h3 className="text-sm font-semibold flex-1 truncate">
            {adHoc ? (
              <>
                <span className="text-muted">tick window</span>
                {' · '}{fmtFullTime(trade.entry_ts)}
              </>
            ) : (
              <>
                <span className={isLong ? 'text-buy' : 'text-sell'}>{trade.side.toUpperCase()}</span>
                {' · '}qty={trade.qty}
                {' · entry '}{fmtFullTime(trade.entry_ts)}{' @ '}{trade.entry_px.toFixed(2)}
                {trade.exit_ts && <>
                  {' · exit '}{fmtFullTime(trade.exit_ts)}{' @ '}{(trade.exit_px ?? 0).toFixed(2)}
                  {' '}<span className={trade.pnl > 0 ? 'text-win' : 'text-loss'}>{fmtPnl(trade.pnl)}</span>
                </>}
              </>
            )}
          </h3>
          <button onClick={onPrev} disabled={!onPrev}
                  className="text-muted hover:text-text disabled:opacity-25 px-1">◀</button>
          <button onClick={onNext} disabled={!onNext}
                  className="text-muted hover:text-text disabled:opacity-25 px-1">▶</button>
          <button onClick={onClose} className="text-muted hover:text-text text-lg leading-none">×</button>
        </div>

        {/* Summary 3-col (only when this is a real trade -- ad-hoc bar
            clicks just want the tick chart). */}
        {!adHoc && (
          <div className="grid grid-cols-3 gap-x-6 text-xs tnum mb-3 px-2 py-2 bg-bg/50 rounded">
            <div className="space-y-1">
              <KV k="trade" v={fmtTradeSpec(trade, audit)} cls={isLong ? 'text-buy' : 'text-sell'} />
              <KV k="TP"    v={fmtTicksAbs(bracketSrc?.tp_ticks, tpPx)}  cls="text-tp" />
              <KV k="SL"    v={fmtTicksAbs(bracketSrc?.sl_ticks, slPx)}  cls="text-sl" />
              <KV k="TT"    v={fmtTrailAbs(bracketSrc, tsPx)}            cls="text-trail" />
            </div>
            <div className="space-y-1">
              <KV k="algo entry"   kw={92} v={fmtTimePx(algoTrade?.entry_ts, algoTrade?.entry_px)}
                  cls={algoTrade ? '' : 'text-muted'} />
              <KV k="broker entry" kw={92} v={fmtTimePx(brokerTrade?.entry_ts, brokerTrade?.entry_px)}
                  cls={brokerTrade ? '' : 'text-muted'} />
              <KV k="algo exit"    kw={92} v={fmtTimePx(algoTrade?.exit_ts, algoTrade?.exit_px)}
                  cls={algoTrade ? '' : 'text-muted'} />
              <KV k="broker exit"  kw={92} v={fmtTimePx(brokerTrade?.exit_ts, brokerTrade?.exit_px)}
                  cls={brokerTrade ? '' : 'text-muted'} />
            </div>
            <div className="space-y-1">
              <KV k="duration" v={trade.exit_ts ? fmtDuration(trade.exit_ts - trade.entry_ts) : '—'} />
              <KV k="reason"   v={decision?.reason || trade.reason || 'EXIT'} />
              <KV k="profit"   v={fmtPnl(trade.pnl)} cls={trade.pnl > 0 ? 'text-win' : 'text-loss'} />
              <KV k="comment"  v={trade.algo_id || ''} />
            </div>
          </div>
        )}

        {/* Webhook bracket (what was POSTed to the relay for this trade)
            sits on the left; chart legend rides on the right. Legend is
            always visible; webhook only when we have an audit match. */}
        <div className="flex gap-3 mb-3">
          {!adHoc && audit && (
            <div className="flex-1 min-w-0">
              <WebhookPanel audit={audit} trade={trade} />
            </div>
          )}
          <div className={(!adHoc && audit) ? 'shrink-0' : 'flex-1'}>
            <ChartLegendPanel />
          </div>
        </div>

        {/* Tick chart */}
        <TickChart
          ticks={ticks}
          err={err}
          source={source}
          brokerTrade={brokerTrade}
          algoTrade={algoTrade}
          entryPx={trade.entry_px}
          side={trade.side}
          slPx={slPx}
          tpPx={tpPx}
          tsPx={tsPx}
          fromNs={fromNs}
          toNs={toNs}
        />

        {/* Legend */}
        <div className="flex items-center gap-4 mt-2 text-[10px] text-muted">
          <span><span className="text-short">●</span> bid · <span className="text-long">●</span> ask</span>
          <span><span className="text-accent">▶</span> long / <span className="text-trail">▶</span> short entry</span>
          <span><span className="text-win">◀</span> win / <span className="text-loss">◀</span> loss exit</span>
          <span><span className="text-sl">SL</span></span>
        </div>
    </div>
  );
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Webhook bracket panel — surfaces what was actually sent over the
// wire to the broker for THIS trade. The runner POSTs a single bracket
// (entry + SL + TP + trail params) per intent; the broker executes all
// exits server-side. So when the broker's exit price diverges from the
// algo's simulated exit, this is the first thing to check (per
// reference_execution_model_broker_owned_brackets memory).
//
// Derives absolute SL / TP / trail-arm prices from the entry + tick
// counts so the user can map "27 SL ticks" → "28920.25" without doing
// the math in their head. Tick size pinned to 0.25 for MNQ; if other
// symbols enter the mix, lift this out.
function WebhookPanel({ audit, trade }) {
  const req = audit?.request || {};
  const sl_ticks      = Number(req.stop_loss     ?? 0);
  const tp_ticks      = Number(req.take_profit   ?? 0);
  const trail_trig_t  = Number(req.trail_trigger ?? 0);
  const trail_dist_t  = Number(req.trail_dist    ?? 0);
  const entry = Number(req.price ?? trade?.entry_px ?? 0);
  const isShort = (req.action || '').toLowerCase().includes('sell');
  // dir = +1 favorable for long (profit when price rises),
  //       -1 favorable for short (profit when price falls).
  // SL is adverse:    entry - dir * ticks * TICK
  // TP / trail-arm are favorable: entry + dir * ticks * TICK
  const dir = isShort ? -1 : +1;
  const slPx       = sl_ticks     ? entry - dir * sl_ticks     * TICK : null;
  const tpPx       = tp_ticks     ? entry + dir * tp_ticks     * TICK : null;
  // Trail arms after price moves trail_trig_t ticks in FAVOR of the
  // position; once armed, the SL trails the favorable extreme by
  // trail_dist_t ticks. The "arm" price is the favorable threshold.
  const trailArmPx = trail_trig_t ? entry + dir * trail_trig_t * TICK : null;

  const status = audit?.status;
  const statusOk = status != null && status >= 200 && status < 300;
  const sigId = req.algo_signal_id || '—';
  const algo = req.algo_id || '—';
  const tif = req.time_in_force ? `${req.time_in_force}${req.expire_at ? ' ' + req.expire_at + 's' : ''}` : '—';

  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs tnum px-2 py-2 bg-bg/50 rounded">
      <div className="col-span-2 text-[10px] uppercase tracking-wide text-muted mb-1">
        webhook bracket sent to broker
        <span className={`ml-2 ${statusOk ? 'text-long' : 'text-short'}`}>
          {status != null ? `HTTP ${status}${statusOk ? ' ok' : ''}` : 'no audit match'}
        </span>
      </div>
      <KV k="SL"          v={`${sl_ticks}t  →  ${slPx?.toFixed(2) ?? '—'}`}    cls="text-sl" />
      <KV k="TP"          v={`${tp_ticks}t  →  ${tpPx?.toFixed(2) ?? '—'}`}    cls="text-tp" />
      <KV k="trail arm"   v={`${trail_trig_t}t  →  ${trailArmPx?.toFixed(2) ?? '—'}`} cls="text-trail" />
      <KV k="trail dist"  v={`${trail_dist_t}t (= ${(trail_dist_t * TICK).toFixed(2)} pts)`} cls="text-trail" />
      <KV k="time-in-force" v={tif} />
      <KV k="signal id"     v={sigId} />
      <KV k="algo"          v={algo} />
      <KV k="POST ts"       v={fmtFullTime(audit?.ts_ns ?? 0)} />
      <details className="col-span-2 mt-2 cursor-pointer">
        <summary className="text-[10px] uppercase tracking-wide text-muted hover:text-text">
          raw payload
        </summary>
        <pre className="mt-1 text-[10px] leading-tight bg-bg p-2 rounded border border-border overflow-x-auto whitespace-pre">
{JSON.stringify(redactSecrets({ request: audit?.request, response: audit?.response, status: audit?.status }), null, 2)}
        </pre>
      </details>
    </div>
  );
}

// Chart legend panel — what every shape/color on the tick chart means.
// Rides to the right of WebhookPanel. Stays compact so webhook keeps
// most of the row width.
function ChartLegendPanel() {
  return (
    <div className="text-[10px] tnum px-2 py-2 bg-bg/50 rounded h-full">
      <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
        chart legend
      </div>
      <div className="space-y-1">
        <LegendRow>
          <LegendSwatch color="#7fc6d4" line />
          <span>bid</span>
          <span className="text-muted ml-1">·</span>
          <LegendSwatch color="#d4be7a" line />
          <span>ask</span>
        </LegendRow>
        <LegendRow>
          <LegendSwatch color="rgba(127,255,0,0.5)" />
          <span>buy print (ask lifted)</span>
        </LegendRow>
        <LegendRow>
          <LegendSwatch color="rgba(239,83,80,0.5)" />
          <span>sell print (bid hit)</span>
        </LegendRow>
        <LegendRow>
          <LegendSwatch color="rgba(127,255,0,0.5)" small />
          <LegendSwatch color="rgba(127,255,0,0.5)" />
          <LegendSwatch color="rgba(127,255,0,0.5)" big />
          <span className="text-muted ml-1">size = trade quantity</span>
        </LegendRow>
        <LegendRow>
          <span className="text-muted italic">prints hidden when window ≥ 30s</span>
        </LegendRow>
      </div>
    </div>
  );
}

function LegendRow({ children }) {
  return <div className="flex items-center gap-1.5">{children}</div>;
}

function LegendSwatch({ color, line, small, big }) {
  if (line) {
    return (
      <span
        className="inline-block"
        style={{ width: 12, height: 2, backgroundColor: color, borderRadius: 1 }}
      />
    );
  }
  const r = small ? 3 : big ? 9 : 6;
  return (
    <span
      className="inline-block rounded-full"
      style={{ width: r, height: r, backgroundColor: color }}
    />
  );
}

function TickChart({ ticks, err, source, brokerTrade, algoTrade, entryPx, side, slPx, tpPx, tsPx, fromNs, toNs }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  // Zoom/pan window. Defaults to the full [fromNs, toNs] passed in;
  // mouse wheel zooms around the cursor x, drag pans. Y-range is
  // recomputed inside the visible window each draw so zoom auto-
  // rescales price (essential for studying tick-scale FillModel
  // behavior at e.g. trail-trigger moments).
  const [view, setView] = useState({ from: fromNs, to: toNs });
  // Reset zoom whenever the source window changes (i.e. user navigated
  // to a different trade).
  useEffect(() => { setView({ from: fromNs, to: toNs }); }, [fromNs, toNs]);

  // Drag-to-pan state. Refs not state -- mid-drag should not re-render.
  const dragRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const draw = () => drawTickChart(cv, wrap, ticks, brokerTrade, algoTrade, entryPx, side, slPx, tpPx, tsPx, view.from, view.to);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [ticks, brokerTrade, algoTrade, entryPx, side, slPx, tpPx, tsPx, view]);

  const onWheel = (e) => {
    e.preventDefault();
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const fracX = (e.clientX - rect.left) / rect.width;       // 0..1
    const span = view.to - view.from;
    // deltaY > 0 (scroll down) = zoom out; < 0 = zoom in. 1.15 ratio
    // per wheel-tick reads as a smooth, predictable zoom.
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const newSpan = Math.max(1_000_000_000, span * factor);   // 1s minimum
    const pivot = view.from + span * fracX;
    setView({
      from: Math.round(pivot - newSpan * fracX),
      to:   Math.round(pivot + newSpan * (1 - fracX)),
    });
  };
  const onMouseDown = (e) => {
    if (e.button !== 0) return;   // left-button only
    dragRef.current = { x: e.clientX, from: view.from, to: view.to };
  };
  const onMouseMove = (e) => {
    if (!dragRef.current) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const span = dragRef.current.to - dragRef.current.from;
    const dxFrac = (e.clientX - dragRef.current.x) / rect.width;
    const shift = -span * dxFrac;
    setView({
      from: Math.round(dragRef.current.from + shift),
      to:   Math.round(dragRef.current.to   + shift),
    });
  };
  const onMouseUp   = () => { dragRef.current = null; };
  const onMouseLeave = () => { dragRef.current = null; };
  const reset = () => setView({ from: fromNs, to: toNs });
  const zoomed = view.from !== fromNs || view.to !== toNs;

  // Per prime directive: surface where the ticks actually came from.
  // Live ring vs disk archive is meaningful for "is this what the
  // strategy actually saw at the time?" — archive is canonical
  // Databento capture; ring is coord's live subscription.
  const sourceLabel = (
    source === 'coord'           ? 'live buffer' :
    source === 'archive'         ? 'disk archive' :
    source === 'archive-loading' ? 'fetching from archive…' :
    null
  );

  return (
    <div ref={wrapRef} className="relative w-full h-72 bg-bg rounded">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      />
      {ticks === null && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">
          loading ticks…
        </div>
      )}
      {ticks && ticks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">
          {err
            ? `error: ${err}`
            : 'no ticks in window — outside live buffer and not in archive'}
        </div>
      )}
      {source === 'archive-loading' && (
        <div className="absolute top-1 right-2 text-[10px] text-muted">
          fetching from archive…
        </div>
      )}
      {ticks && ticks.length > 0 && sourceLabel && (
        <div className="absolute top-1 right-2 flex items-center gap-2 text-[10px] tnum">
          {zoomed && (
            <button onClick={reset}
                    className="px-1.5 py-0 rounded border border-accent/40 text-accent bg-accent/10 hover:bg-accent/20"
                    title="Reset zoom">
              RESET
            </button>
          )}
          <span className="text-muted">
            {ticks.length.toLocaleString()} ticks · source: {sourceLabel}
            {zoomed && ` · ${fmtSpan(view.to - view.from)}`}
          </span>
        </div>
      )}
    </div>
  );
}

// X-axis time formatter for the tick chart. Spills hierarchically:
// labels show their position WITHIN the next-coarser unit, except at
// boundary crossings where they show the coarser unit itself.
//   sub-sec step: .NNN within a second; :NN at the second roll
//   sub-min step: :NN within a minute; HH:MM at the minute roll
//   minute+ step: HH:MM (seconds always 00 at minute steps)
// So a 100ms axis reads:
//   .100 .200 .300 .400 .500 .600 .700 .800 .900 :58 .100 .200
// And a 5s axis reads:
//   :40 :45 :50 :55 12:35 :05 :10 :15 :20 :25 :30
// One spill rule, applied at every level.
function fmtTickAxisTime(ns, xStepNs) {
  const d = new Date(ns / 1e6);
  const ms = d.getMilliseconds();
  const sec = d.getSeconds();
  const pad2 = (n) => String(n).padStart(2, '0');
  if (xStepNs < 1_000_000_000) {
    if (ms === 0) return `:${pad2(sec)}`;
    return `.${String(ms).padStart(3, '0')}`;
  }
  if (xStepNs < 60_000_000_000) {
    if (sec === 0) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `:${pad2(sec)}`;
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtSpan(ns) {
  const sec = ns / 1e9;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}min`;
  return `${(sec / 3600).toFixed(1)}h`;
}

function drawTickChart(cv, wrap, ticks, brokerTrade, algoTrade, entryPx, side, slPx, tpPx, tsPx, fromNs, toNs) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth;
  const cssH = wrap.clientHeight;
  cv.width  = cssW * dpr;
  cv.height = cssH * dpr;
  cv.style.width  = cssW + 'px';
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, cssW, cssH);
  if (!ticks || ticks.length === 0) return;

  const PAD = { top: 12, bottom: 24, left: 60, right: 12 };
  const x0 = PAD.left, x1 = cssW - PAD.right;
  const y0 = PAD.top,  y1 = cssH - PAD.bottom;

  // Y range: include all bid/ask + entry + exit + SL.
  // Recompute y-range from quote ticks WITHIN the visible window so
  // zoom auto-rescales price. (Static range over all data was useless
  // when zooming in on a 1s span -- price collapsed into a sliver.)
  // Trade prints (kind:'trade') aren't included in the range -- their
  // price is by definition between bid/ask of their moment, so the
  // bid/ask sweep already covers them.
  let pmin = Infinity, pmax = -Infinity;
  for (const t of ticks) {
    if (t.kind === 'trade') continue;
    if (t.ts_ns < fromNs || t.ts_ns > toNs) continue;
    if (t.bid < pmin) pmin = t.bid;
    if (t.bid > pmax) pmax = t.bid;
    if (t.ask < pmin) pmin = t.ask;
    if (t.ask > pmax) pmax = t.ask;
  }
  // Fallback: zoomed-in window may have zero quotes (sparse periods);
  // use the un-windowed range so the chart still renders something.
  if (!Number.isFinite(pmin)) {
    for (const t of ticks) {
      if (t.kind === 'trade') continue;
      if (t.bid < pmin) pmin = t.bid;
      if (t.bid > pmax) pmax = t.bid;
      if (t.ask < pmin) pmin = t.ask;
      if (t.ask > pmax) pmax = t.ask;
    }
  }
  // No price-extension AT ALL -- y-range is the visible-window ticks
  // alone. Bracket lines (entry / TT / SL / TP) and entry/exit
  // triangles (broker / algo) render conditionally on already being
  // in band. At default zoom the window is centered on the trade so
  // they naturally fall inside the tick-derived range. On zoom-in
  // away from entry, off-band markers simply skip -- nothing
  // compresses the area being studied.
  const pad = (pmax - pmin) * 0.05 || 0.5;
  pmin -= pad; pmax += pad;
  const xT = (ts) => x0 + (x1 - x0) * (ts - fromNs) / (toNs - fromNs);
  const yP = (p)  => y1 - (y1 - y0) * (p - pmin) / (pmax - pmin);

  // Y axis: tick-aligned labels at a "nice" step (smallest power-of-2
  // multiple of TICK that yields <=6 labels across the range). Avoids
  // junk values like 29676.91 -- MNQ price levels are always multiples
  // of 0.25.
  ctx.fillStyle = '#7c8190';
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  let yStep = TICK;
  while ((pmax - pmin) / yStep > 6) yStep *= 2;
  const yStart = Math.ceil(pmin / yStep) * yStep;
  for (let p = yStart; p <= pmax + 1e-9; p += yStep) {
    const y = yP(p);
    ctx.fillText(p.toFixed(2), x0 - 4, y);
    ctx.strokeStyle = '#1a1d23';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }
  // X axis: nice-step labels with vertical grid lines (matches y).
  // Step picked from a fixed series so labels land on round
  // 10ms/100ms/1s/etc boundaries -- aim ~6-10 labels across the
  // visible window. Labels "spill" between formats: at sub-second
  // step, ms-aligned slots show `.NNN`, second boundaries show
  // `:NN` so the operator can see "where am I within the second"
  // and "when did the second roll over" without doing math.
  const spanNs = toNs - fromNs;
  // 12 = at the 1s zoom floor we get 100ms-step grid (1s/100ms=10 <= 12).
  // Was 8 -- gave 200ms steps at full zoom, less useful for tick-scale
  // FillModel investigation.
  const targetN = 12;
  const NICE_STEPS_NS = [
    10_000_000, 20_000_000, 50_000_000,             // 10/20/50ms
    100_000_000, 200_000_000, 500_000_000,          // 100/200/500ms
    1_000_000_000, 2_000_000_000, 5_000_000_000,    // 1/2/5s
    10_000_000_000, 15_000_000_000, 30_000_000_000, // 10/15/30s
    60_000_000_000, 120_000_000_000, 300_000_000_000,   // 1/2/5min
    600_000_000_000, 1800_000_000_000, 3600_000_000_000, // 10/30/60min
  ];
  let xStep = NICE_STEPS_NS[NICE_STEPS_NS.length - 1];
  for (const s of NICE_STEPS_NS) {
    if (spanNs / s <= targetN) { xStep = s; break; }
  }
  const xStart = Math.ceil(fromNs / xStep) * xStep;
  ctx.fillStyle = '#7c8190';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let ts = xStart; ts <= toNs; ts += xStep) {
    const x = x0 + (x1 - x0) * (ts - fromNs) / spanNs;
    ctx.strokeStyle = '#1a1d23';
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.fillText(fmtTickAxisTime(ts, xStep), x, y1 + 4);
  }

  // Bracket lines: render only when their price is already inside
  // the (tick-derived) y-band. Forcing entry/TT into range was useful
  // for the static view but fights the operator the moment they zoom
  // into a region away from those prices. All four lines now follow
  // the same in-band rule -- colors match the entry-triangle /
  // summary-KV palette so long vs short reads at a glance.
  const entryColor = side === 'long' ? '#1976d2' : '#ffff00';
  const inBand = (p) => p != null && Number.isFinite(p) && p >= pmin && p <= pmax;
  if (inBand(entryPx)) drawHLine(ctx, x0, x1, yP, entryPx, entryColor, `entry ${entryPx.toFixed(2)}`);
  if (inBand(tsPx))    drawHLine(ctx, x0, x1, yP, tsPx,    '#fb923c',  `TT ${tsPx.toFixed(2)}`);
  if (inBand(slPx))    drawHLine(ctx, x0, x1, yP, slPx,    '#ef5350',  `SL ${slPx.toFixed(2)}`);
  if (inBand(tpPx))    drawHLine(ctx, x0, x1, yP, tpPx,    '#7fff00',  `TP ${tpPx.toFixed(2)}`);

  // bid line (cyan-ish, like playground) and ask (amber)
  drawLine(ctx, ticks, xT, yP, 'bid', '#7fc6d4');
  drawLine(ctx, ticks, xT, yP, 'ask', '#d4be7a');
  // Trade prints (kind:'trade' records) -- one filled dot per print.
  // Color = aggressor:
  //   side=B (bid was hit -> aggressive seller) -> red
  //   side=A (ask was hit -> aggressive buyer)  -> green
  //   side=N (not classified)                   -> grey
  // 50% alpha so the bid/ask lines stay readable underneath. Hidden
  // entirely when the visible window is >= 30s -- at that span the
  // dots carpet the chart and obscure the b/a lines. Inside 30s,
  // radius ramps logarithmically with zoom (linear-per-ms would 30x
  // from 30s->1s, way too aggressive); +2 per decade of zoom, capped.
  // Size still adds a small per-print bump on top.
  const ZOOM_GATE_NS = 30 * 1_000_000_000;
  if (spanNs < ZOOM_GATE_NS) {
    const spanSec = spanNs / 1e9;
    const zoomBoost = 2 * Math.log10(30 / Math.max(0.001, spanSec));
    const baseR = Math.max(1.5, Math.min(8, 2 + zoomBoost));
    // Bucket on a coarse pixel grid (BUCKET_PX) -- not raw ts_ns,
    // not single pixels. Exchange matching engines give every leg
    // of a sweep its own monotonic ts_event in nanoseconds, so a
    // (ts_ns, px) key almost never merges anything. Single-pixel
    // bucketing helped a little but small dots still visually
    // overlap across a few pixels, so the alpha compounds instead
    // of the radius growing. An 8px grid groups "things the eye
    // sees as the same dot" at any reasonable zoom. Side stays in
    // the key so a B-leg and A-leg in the same cell don't get
    // color-blended into nonsense.
    //
    // Draw position is the size-weighted centroid of the cell --
    // honest about where the volume actually was rather than
    // snapping to the cell center.
    const BUCKET_PX = 8;
    const buckets = new Map();
    for (const t of ticks) {
      if (t.kind !== 'trade') continue;
      if (t.ts_ns < fromNs || t.ts_ns > toNs) continue;
      if (t.price < pmin || t.price > pmax) continue;
      const cxR = xT(t.ts_ns), cyR = yP(t.price);
      const bx = Math.round(cxR / BUCKET_PX);
      const by = Math.round(cyR / BUCKET_PX);
      const key = `${bx}|${by}|${t.side}`;
      const sz = t.size || 0;
      const w  = sz || 1;
      const cur = buckets.get(key);
      if (cur) {
        cur.size  += sz;
        cur.sumX  += cxR * w;
        cur.sumY  += cyR * w;
        cur.wsum  += w;
      } else {
        buckets.set(key, { sumX: cxR * w, sumY: cyR * w, wsum: w, side: t.side, size: sz });
      }
    }
    for (const t of buckets.values()) {
      const sz = t.size || 1;
      // Two channels encode size: radius (sqrt ramp, cap +10) and
      // opacity (log10 ramp, 0.4 -> 0.85). Both go up with sz so a
      // big cluster reads as both bigger AND more saturated, while a
      // 1-lot is small AND faint and stays out of the way.
      //   r:     sz=1 +0.9 | sz=16 +3.6 | sz=100 +9 | sz=124+ cap +10
      //   alpha: sz=1 0.48 | sz=10 0.66 | sz=50 0.83 | sz=100+ cap 0.85
      const r = baseR + Math.min(10, Math.sqrt(sz) * 0.9);
      const alpha = Math.min(0.85, 0.4 + Math.log10(sz + 1) * 0.25);
      const rgb = t.side === 'B' ? '239,83,80'
                : t.side === 'A' ? '127,255,0'
                :                  '124,129,144';
      const cx = t.sumX / t.wsum;
      const cy = t.sumY / t.wsum;
      ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Broker entry/exit (solid) — the ground truth for what executed.
  // Skip when no broker counterpart exists (algo-only trade -- runner
  // POSTed but the broker didn't fill); the algo's hollow markers
  // below carry the rendering on their own. Also skip when the
  // marker's price is outside the visible y-band so off-window
  // triangles don't pollute the canvas edges.
  if (brokerTrade?.entry_ts && inBand(brokerTrade.entry_px)
      && brokerTrade.entry_ts >= fromNs && brokerTrade.entry_ts <= toNs) {
    const ex = xT(brokerTrade.entry_ts);
    const ey = yP(brokerTrade.entry_px);
    drawArrow(ctx, ex, ey, brokerTrade.side === 'long' ? '#1976d2' : '#ffff00', 'right');
  }
  if (brokerTrade?.exit_ts && inBand(brokerTrade.exit_px)
      && brokerTrade.exit_ts >= fromNs && brokerTrade.exit_ts <= toNs) {
    const xx = xT(brokerTrade.exit_ts);
    const yy = yP(brokerTrade.exit_px);
    drawArrow(ctx, xx, yy, brokerTrade.pnl > 0 ? '#7fff00' : '#ef5350', 'left');
  }
  // Algo-sim entry/exit (hollow) — what the runner THOUGHT it filled at.
  // Compare to the solid broker arrow at the same position to see slip
  // (horizontal gap = time-of-fill diff; vertical gap = px diff).
  if (algoTrade?.entry_ts && inBand(algoTrade.entry_px)
      && algoTrade.entry_ts >= fromNs && algoTrade.entry_ts <= toNs) {
    const ex = xT(algoTrade.entry_ts);
    const ey = yP(algoTrade.entry_px);
    drawArrow(ctx, ex, ey, algoTrade.side === 'long' ? '#1976d2' : '#ffff00', 'right', /*hollow*/ true);
  }
  if (algoTrade?.exit_ts && inBand(algoTrade.exit_px)
      && algoTrade.exit_ts >= fromNs && algoTrade.exit_ts <= toNs) {
    const xx = xT(algoTrade.exit_ts);
    const yy = yP(algoTrade.exit_px);
    drawArrow(ctx, xx, yy, (algoTrade.pnl ?? 0) > 0 ? '#7fff00' : '#ef5350', 'left', /*hollow*/ true);
  }
}

// Dotted horizontal line at price `p` spanning the chart width with
// a small label at the left edge. Used for entry / SL / TT brackets
// on the per-trade tick chart.
function drawHLine(ctx, x0, x1, yP, p, color, label) {
  if (p == null || !Number.isFinite(p)) return;
  const y = yP(p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.setLineDash([]);
  if (label) {
    ctx.fillStyle = color;
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x0 + 4, y - 2);
  }
}

function drawLine(ctx, ticks, xT, yP, key, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (const t of ticks) {
    if (t.kind === 'trade') continue;     // trades are drawn as dots
    if (t[key] == null) continue;
    const x = xT(t.ts_ns), y = yP(t[key]);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawArrow(ctx, x, y, color, dir, hollow = false) {
  ctx.beginPath();
  if (dir === 'right') {
    ctx.moveTo(x, y);
    ctx.lineTo(x - 14, y - 8);
    ctx.lineTo(x - 14, y + 8);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + 14, y - 8);
    ctx.lineTo(x + 14, y + 8);
  }
  ctx.closePath();
  if (hollow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function KV({ k, v, cls = '', kw }) {
  // Optional `kw` (label width in px) pins the label column so values
  // start at the same x-coord across rows -- makes comparing
  // "HH:MM:SS @ price" cells column-by-column trivial.
  const labelStyle = kw ? { width: `${kw}px` } : undefined;
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted shrink-0 text-[11px]" style={labelStyle}>{k}</span>
      <span className={`${cls} text-text font-semibold`}>{v}</span>
    </div>
  );
}

// Compact "HH:MM:SS @ price" cell for the broker/algo entry/exit
// comparison. Returns the em-dash placeholder when either field is
// missing -- happens for the algo column when no algo counterpart was
// matched, and for either exit field on still-open positions.
function fmtTimePx(ns, px) {
  if (!ns || px == null) return '—';
  const t = new Date(ns / 1e6).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  return `${t} @ ${px.toFixed(2)}`;
}

// One-line trade spec: '<order-type> <SIDE> <qty> <symbol>'.
// Order type defaults to LMT (XOVD always places limit entries via
// the relay); audit.request.type can override when the runner sends
// something else (market emergency-flatten, etc). Symbol pulled from
// audit.request.ticker when present, else falls back to MNQ (the
// project's only live symbol today).
function fmtTradeSpec(trade, audit) {
  const req = audit?.request || {};
  let orderType = (req.type || req.order_type || 'LMT').toUpperCase();
  if (orderType === 'LIMIT') orderType = 'LMT';
  if (orderType === 'MARKET') orderType = 'MKT';
  const side = trade.side.toUpperCase();
  const sym = (req.ticker || req.symbol || 'MNQ').replace(/[!1]+$/, '');
  return `${orderType} ${side} ${trade.qty} ${sym}`;
}

// "<ticks>t - <abs_price>" formatter for the TP / SL rows. Trader
// thinks in ticks when sizing brackets; abs price is the eye-check
// against the chart. Em-dash when either side missing.
function fmtTicksAbs(ticks, px) {
  if (ticks == null) return '—';
  if (px == null)    return `${ticks}t`;
  return `${ticks}t - ${px.toFixed(2)}`;
}

// Trail row: trigger ticks / dist ticks - arm price.
// Trigger has an abs (the "arm at this price" target); distance is a
// delta with no single abs equivalent.
function fmtTrailAbs(decision, armPx) {
  const trig = decision?.trail_trigger_ticks;
  const dist = decision?.trail_dist_ticks;
  if (trig == null || dist == null) return '—';
  if (armPx == null) return `${trig}t / ${dist}t`;
  return `${trig}t / ${dist}t - ${armPx.toFixed(2)}`;
}

function fmtFullTime(ns) {
  return new Date(ns / 1e6).toLocaleString([], {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
function fmtPnl(p) {
  if (p == null) return '';
  return (p > 0 ? '+' : '') + p.toFixed(2);
}
function fmtDuration(deltaNs) {
  const sec = Math.round(deltaNs / 1e9);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${min}m ${ss}s`;
}
