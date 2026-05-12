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

export default function TradeTickModal({ trade, decision, onClose, onPrev, onNext }) {
  const [ticks, setTicks] = useState(null);   // null = loading, [] = no data, [...] = ok
  const [err, setErr] = useState(null);
  const [source, setSource] = useState(null); // 'coord' | 'archive' | null

  const fromNs = trade?.entry_ts ? trade.entry_ts - PRE_PAD_NS : 0;
  const toNs   = trade?.exit_ts  ? trade.exit_ts  + POST_PAD_NS : (trade?.entry_ts || 0) + PRE_PAD_NS;

  useEffect(() => {
    if (!trade) return;
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
            setSource(arr2.length > 0 ? 'archive' : null);
            setTicks(arr2);
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

        {/* Summary 2-col */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs tnum mb-3 px-2 py-2 bg-bg/50 rounded">
          <KV k="direction" v={trade.side.toUpperCase()} cls={isLong ? 'text-buy' : 'text-sell'} />
          <KV k="size"      v={trade.qty} />
          <KV k="entry"     v={trade.entry_px.toFixed(2)} />
          <KV k="SL @ entry" v={slPx ? slPx.toFixed(2) : '—'} cls={slPx ? 'text-sl' : ''} />
          <KV k="exit"      v={trade.exit_px?.toFixed(2) ?? '—'} />
          <KV k="TP @ entry" v={tpPx ? tpPx.toFixed(2) : '—'} cls={tpPx ? 'text-tp' : ''} />
          <KV k="reason"    v={decision?.reason || trade.reason || 'EXIT'} />
          <KV k="duration"  v={trade.exit_ts ? fmtDuration(trade.exit_ts - trade.entry_ts) : '—'} />
          <KV k="profit"    v={fmtPnl(trade.pnl)} cls={trade.pnl > 0 ? 'text-win' : 'text-loss'} />
          <KV k="comment"   v={trade.algo_id || ''} />
        </div>

        {/* Tick chart */}
        <TickChart
          ticks={ticks}
          err={err}
          source={source}
          trade={trade}
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

function TickChart({ ticks, err, source, trade, slPx, fromNs, toNs }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const draw = () => drawTickChart(cv, wrap, ticks, trade, slPx, fromNs, toNs);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [ticks, trade, slPx, fromNs, toNs]);

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

function drawTickChart(cv, wrap, ticks, trade, slPx, fromNs, toNs) {
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
  if (trade.entry_px) { pmin = Math.min(pmin, trade.entry_px); pmax = Math.max(pmax, trade.entry_px); }
  if (trade.exit_px) { pmin = Math.min(pmin, trade.exit_px); pmax = Math.max(pmax, trade.exit_px); }
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

  // Entry marker
  if (trade.entry_ts) {
    const ex = xT(trade.entry_ts);
    const ey = yP(trade.entry_px);
    drawArrow(ctx, ex, ey, trade.side === 'long' ? '#1976d2' : '#ffff00', 'right');
    ctx.fillStyle = '#fff';
    ctx.font = '10px ui-monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`ENTRY ${trade.entry_px.toFixed(2)}`, ex + 6, ey - 6);
  }
  if (trade.exit_ts && trade.exit_px) {
    const xx = xT(trade.exit_ts);
    const yy = yP(trade.exit_px);
    drawArrow(ctx, xx, yy, trade.pnl > 0 ? '#7fff00' : '#ef5350', 'left');
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

function drawArrow(ctx, x, y, color, dir) {
  ctx.fillStyle = color;
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
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function KV({ k, v, cls = '' }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted shrink-0 text-[11px]">{k}</span>
      <span className={`${cls} text-text font-semibold`}>{v}</span>
    </div>
  );
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
