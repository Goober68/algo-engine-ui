// Cross-slot trade timeline. One horizontal lane per slot; X = time
// across the run window. Marker per trade: entry triangle (up=long,
// down=short), exit dot colored by win/loss. Visualizes signal-firing
// coordination — see at a glance whether slots fire together or
// independently, and where their reasons diverge.
//
// Canvas-rendered for crispness; SVG would also work at this volume.

import { useEffect, useRef, useMemo } from 'react';

const SLOT_COLORS = ['#5fa8ff', '#ffb300', '#d39de4'];
const ROW_H = 36;
const PADDING = { top: 16, bottom: 28, left: 60, right: 12 };

export default function TradeTimeline({ meta, slotsData }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);

  // Compute global time bounds once. Use broker truth (real fills) for
  // marker positions; sim trades aren't displayed here.
  const bounds = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const d of slotsData) {
      if (!d) continue;
      for (const t of d.broker) {
        lo = Math.min(lo, t.entry_ts);
        hi = Math.max(hi, t.exit_ts ?? t.entry_ts);
      }
    }
    return { lo, hi };
  }, [slotsData]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = wrap.clientWidth;
      const cssH = PADDING.top + PADDING.bottom + ROW_H * slotsData.length;
      cv.width  = cssW * dpr;
      cv.height = cssH * dpr;
      cv.style.width  = cssW + 'px';
      cv.style.height = cssH + 'px';
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      drawAxes(ctx, cssW, cssH, bounds);
      drawLanes(ctx, cssW, cssH, slotsData, meta, bounds);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [slotsData, meta, bounds]);

  return (
    <div className="bg-panel border border-border rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted mb-1">trade timeline</div>
      <div ref={wrapRef} className="relative w-full">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

function drawAxes(ctx, cssW, cssH, bounds) {
  const x0 = PADDING.left;
  const x1 = cssW - PADDING.right;
  const y1 = cssH - PADDING.bottom;
  // X axis line
  ctx.strokeStyle = '#2a2e36';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  // Time ticks — 6 evenly spaced
  ctx.fillStyle = '#7c8190';
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 6; i++) {
    const t = bounds.lo + (bounds.hi - bounds.lo) * (i / 6);
    const x = x0 + (x1 - x0) * (i / 6);
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y1 + 4);
    ctx.stroke();
    const label = new Date(t / 1e6).toISOString().slice(11, 16);
    ctx.fillText(label, x, y1 + 6);
  }
}

function drawLanes(ctx, cssW, cssH, slotsData, meta, bounds) {
  const x0 = PADDING.left;
  const x1 = cssW - PADDING.right;
  const tToX = (ts) => x0 + (x1 - x0) * ((ts - bounds.lo) / (bounds.hi - bounds.lo));
  slotsData.forEach((data, idx) => {
    const y = PADDING.top + ROW_H * idx + ROW_H / 2;
    const color = SLOT_COLORS[idx];
    // Lane label
    ctx.fillStyle = '#d4d7dd';
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const slotMeta = meta.slots[idx];
    ctx.fillText(`slot ${idx}`, 4, y);
    ctx.fillStyle = '#7c8190';
    ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(slotMeta.account, 4, y + 11);
    // Lane line
    ctx.strokeStyle = '#1a1d23';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    // Markers
    if (!data) return;
    for (const t of data.broker) {
      const ex = tToX(t.entry_ts);
      // Entry triangle (up=long, down=short)
      const isLong = t.side === 'long';
      ctx.fillStyle = color;
      ctx.beginPath();
      if (isLong) {
        ctx.moveTo(ex, y - 7);
        ctx.lineTo(ex - 4, y);
        ctx.lineTo(ex + 4, y);
      } else {
        ctx.moveTo(ex, y + 7);
        ctx.lineTo(ex - 4, y);
        ctx.lineTo(ex + 4, y);
      }
      ctx.closePath();
      ctx.fill();
      // Exit dot
      if (t.exit_ts && t.exit_ts > t.entry_ts) {
        const xx = tToX(t.exit_ts);
        // Hold-duration line
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(ex, y);
        ctx.lineTo(xx, y);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = t.pnl > 0 ? '#7fff00' : '#ef5350';
        ctx.beginPath();
        ctx.arc(xx, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}
