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

  const fromNs = trade?.entry_ts ? trade.entry_ts - PRE_PAD_NS : 0;
  const toNs   = trade?.exit_ts  ? trade.exit_ts  + POST_PAD_NS : (trade?.entry_ts || 0) + PRE_PAD_NS;

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
    // Tier 1: coord's in-memory ring buffer (fast, recent ~4h).
    fetch(`${COORD}/tick_history?from_ns=${fromNs}&to_ns=${toNs}`)
      .then(r => r.text())
      .then(text => {
        if (cancelled) return;
        const arr = parseTickNdjson(text);
        if (arr.length > 0) {
          setSource('coord');
          setTicks(arr);
          tickCacheSet(cacheKey, { ticks: arr, source: 'coord' });
          return;
        }
        // Tier 2: archive sidecar (slower, longer-history). Skipped
        // when not configured — modal falls through to "no ticks".
        if (!ARCHIVE) {
          setTicks([]);
          return;
        }
        setSource('archive-loading');
        return fetch(`${ARCHIVE}/tick_history?from_ns=${fromNs}&to_ns=${toNs}`)
          .then(r => r.text())
          .then(text2 => {
            if (cancelled) return;
            const arr2 = parseTickNdjson(text2);
            const src = arr2.length > 0 ? 'archive' : null;
            setSource(src);
            setTicks(arr2);
            if (arr2.length > 0) {
              tickCacheSet(cacheKey, { ticks: arr2, source: 'archive' });
            }
          })
          .catch(e => {
            if (cancelled) return;
            setErr(`archive: ${String(e)}`);
            setTicks([]);
          });
      })
      .catch(e => { if (!cancelled) { setErr(String(e)); setTicks([]); } });
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

  if (!trade) return null;

  // Derive SL/TP prices from matching decision (if available).
  const isLong = trade.side === 'long';
  const dir = isLong ? 1 : -1;
  const slPx = decision?.sl_ticks
    ? trade.entry_px - dir * decision.sl_ticks * TICK : null;
  const tpPx = decision?.tp_ticks
    ? trade.entry_px + dir * decision.tp_ticks * TICK : null;
  const tsPx = decision?.trail_trigger_ticks
    ? trade.entry_px + dir * decision.trail_trigger_ticks * TICK : null;

  return (
    <div
      className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-panel border border-border rounded-md p-4 max-w-5xl w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold flex-1 truncate">
            <span className={isLong ? 'text-buy' : 'text-sell'}>{trade.side.toUpperCase()}</span>
            {' · '}qty={trade.qty}
            {' · entry '}{fmtFullTime(trade.entry_ts)}{' @ '}{trade.entry_px.toFixed(2)}
            {trade.exit_ts && <>
              {' · exit '}{fmtFullTime(trade.exit_ts)}{' @ '}{(trade.exit_px ?? 0).toFixed(2)}
              {' '}<span className={trade.pnl > 0 ? 'text-win' : 'text-loss'}>{fmtPnl(trade.pnl)}</span>
            </>}
          </h3>
          <button onClick={onPrev} disabled={!onPrev}
                  className="text-muted hover:text-text disabled:opacity-25 px-1">◀</button>
          <button onClick={onNext} disabled={!onNext}
                  className="text-muted hover:text-text disabled:opacity-25 px-1">▶</button>
          <button onClick={onClose} className="text-muted hover:text-text text-lg leading-none">×</button>
        </div>

        {/* Summary 3-col:
              col 1 = order specs (direction, size, TP/SL/TT in ticks)
              col 2 = algo/broker entry+exit comparison (label width
                      pinned so HH:MM:SS @ price columns align by eye)
              col 3 = duration / reason / profit / comment */}
        <div className="grid grid-cols-3 gap-x-6 text-xs tnum mb-3 px-2 py-2 bg-bg/50 rounded">
          <div className="space-y-1">
            <KV k="trade" v={fmtTradeSpec(trade, audit)} cls={isLong ? 'text-buy' : 'text-sell'} />
            <KV k="TP"    v={fmtTicksAbs(decision?.tp_ticks, tpPx)}  cls="text-tp" />
            <KV k="SL"    v={fmtTicksAbs(decision?.sl_ticks, slPx)}  cls="text-sl" />
            <KV k="TT"    v={fmtTrailAbs(decision, tsPx)}            cls="text-trail" />
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

        {/* Webhook bracket (what was POSTed to the relay for this trade) */}
        {audit && <WebhookPanel audit={audit} trade={trade} />}

        {/* Tick chart */}
        <TickChart
          ticks={ticks}
          err={err}
          source={source}
          brokerTrade={brokerTrade}
          algoTrade={algoTrade}
          slPx={slPx}
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
    </div>
  );
}

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
    <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs tnum mb-3 px-2 py-2 bg-bg/50 rounded">
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
{JSON.stringify({ request: audit?.request, response: audit?.response, status: audit?.status }, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function TickChart({ ticks, err, source, brokerTrade, algoTrade, slPx, fromNs, toNs }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const draw = () => drawTickChart(cv, wrap, ticks, brokerTrade, algoTrade, slPx, fromNs, toNs);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [ticks, brokerTrade, algoTrade, slPx, fromNs, toNs]);

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
      <canvas ref={canvasRef} className="w-full h-full" />
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
        <div className="absolute top-1 right-2 text-[10px] text-muted tnum">
          {ticks.length.toLocaleString()} ticks · source: {sourceLabel}
        </div>
      )}
    </div>
  );
}

function drawTickChart(cv, wrap, ticks, brokerTrade, algoTrade, slPx, fromNs, toNs) {
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
  let pmin = Infinity, pmax = -Infinity;
  for (const t of ticks) {
    if (t.bid < pmin) pmin = t.bid;
    if (t.bid > pmax) pmax = t.bid;
    if (t.ask < pmin) pmin = t.ask;
    if (t.ask > pmax) pmax = t.ask;
  }
  if (brokerTrade?.entry_px) { pmin = Math.min(pmin, brokerTrade.entry_px); pmax = Math.max(pmax, brokerTrade.entry_px); }
  if (brokerTrade?.exit_px)  { pmin = Math.min(pmin, brokerTrade.exit_px);  pmax = Math.max(pmax, brokerTrade.exit_px); }
  if (algoTrade?.entry_px)   { pmin = Math.min(pmin, algoTrade.entry_px);   pmax = Math.max(pmax, algoTrade.entry_px); }
  if (algoTrade?.exit_px)    { pmin = Math.min(pmin, algoTrade.exit_px);    pmax = Math.max(pmax, algoTrade.exit_px); }
  if (slPx) { pmin = Math.min(pmin, slPx); pmax = Math.max(pmax, slPx); }
  const pad = (pmax - pmin) * 0.05 || 0.5;
  pmin -= pad; pmax += pad;
  const xT = (ts) => x0 + (x1 - x0) * (ts - fromNs) / (toNs - fromNs);
  const yP = (p)  => y1 - (y1 - y0) * (p - pmin) / (pmax - pmin);

  // Y axis labels (3 levels)
  ctx.fillStyle = '#7c8190';
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const frac of [0, 0.5, 1]) {
    const p = pmin + (pmax - pmin) * (1 - frac);
    const y = y0 + (y1 - y0) * frac;
    ctx.fillText(p.toFixed(2), x0 - 4, y);
    ctx.strokeStyle = '#1a1d23';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }
  // X axis labels (3 timestamps)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const frac of [0, 0.5, 1]) {
    const ts = fromNs + (toNs - fromNs) * frac;
    const x = x0 + (x1 - x0) * frac;
    const lbl = new Date(ts / 1e6).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    ctx.fillText(lbl, x, y1 + 4);
  }

  // SL line
  if (slPx != null) {
    const y = yP(slPx);
    ctx.strokeStyle = '#ef5350';
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ef5350';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`SL ${slPx.toFixed(2)}`, x0 + 4, y - 2);
  }

  // bid line (cyan-ish, like playground) and ask (amber)
  drawLine(ctx, ticks, xT, yP, 'bid', '#7fc6d4');
  drawLine(ctx, ticks, xT, yP, 'ask', '#d4be7a');

  // Broker entry/exit (solid) — the ground truth for what executed.
  // Skip when no broker counterpart exists (algo-only trade -- runner
  // POSTed but the broker didn't fill); the algo's hollow markers
  // below carry the rendering on their own.
  if (brokerTrade?.entry_ts) {
    const ex = xT(brokerTrade.entry_ts);
    const ey = yP(brokerTrade.entry_px);
    drawArrow(ctx, ex, ey, brokerTrade.side === 'long' ? '#1976d2' : '#ffff00', 'right');
  }
  if (brokerTrade?.exit_ts && brokerTrade.exit_px) {
    const xx = xT(brokerTrade.exit_ts);
    const yy = yP(brokerTrade.exit_px);
    drawArrow(ctx, xx, yy, brokerTrade.pnl > 0 ? '#7fff00' : '#ef5350', 'left');
  }
  // Algo-sim entry/exit (hollow) — what the runner THOUGHT it filled at.
  // Compare to the solid broker arrow at the same position to see slip
  // (horizontal gap = time-of-fill diff; vertical gap = px diff).
  if (algoTrade?.entry_ts) {
    const ex = xT(algoTrade.entry_ts);
    const ey = yP(algoTrade.entry_px);
    drawArrow(ctx, ex, ey, algoTrade.side === 'long' ? '#1976d2' : '#ffff00', 'right', /*hollow*/ true);
  }
  if (algoTrade?.exit_ts && algoTrade?.exit_px) {
    const xx = xT(algoTrade.exit_ts);
    const yy = yP(algoTrade.exit_px);
    drawArrow(ctx, xx, yy, (algoTrade.pnl ?? 0) > 0 ? '#7fff00' : '#ef5350', 'left', /*hollow*/ true);
  }
}

function drawLine(ctx, ticks, xT, yP, key, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (const t of ticks) {
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
