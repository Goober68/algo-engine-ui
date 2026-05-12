// Cross-slot aggregate stats. Mirrors per-slot StatsStrip layout but
// sums across all slots so the runner panel surfaces "all of this
// runner" at a glance.

import { useMemo } from 'react';

export default function RunnerStatsStrip({ slotsData }) {
  const stats = useMemo(() => compute(slotsData), [slotsData]);
  return (
    <div className="flex items-center gap-4 px-3 py-1 bg-panel border border-border rounded text-xs tnum">
      <Stat label="slots"  v={stats.nSlots} />
      <Stat label="trades" v={stats.n} />
      <Stat label="wins"   v={stats.wins} cls="text-long" />
      <Stat label="loss"   v={stats.losses} cls="text-short" />
      <Stat label="WR"     v={`${stats.wr}%`} />
      <Stat label="PF"     v={stats.pf} />
      <Stat label="net"    v={fmtD(stats.net)}   cls={cls(stats.net)} big />
      <Stat label="DD"     v={fmtD(stats.maxDd)} cls="text-short" />
    </div>
  );
}

function compute(slotsData) {
  let n = 0, wins = 0, losses = 0, gw = 0, gl = 0, net = 0;
  // Combined-equity DD: order all trades by time, walk together.
  const allTrades = [];
  for (const d of slotsData) {
    if (!d) continue;
    for (const t of d.broker) allTrades.push(t);
  }
  allTrades.sort((a, b) => a.entry_ts - b.entry_ts);
  let eq = 0, peak = 0, maxDd = 0;
  for (const t of allTrades) {
    n++;
    if (t.pnl > 0) { wins++; gw += t.pnl; }
    else           { losses++; gl += t.pnl; }
    net += t.pnl;
    eq += t.pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.min(maxDd, eq - peak);
  }
  const pf = gl < 0 ? (gw / -gl).toFixed(2) : '∞';
  const wr = n ? Math.round((wins / n) * 100) : 0;
  return { nSlots: slotsData.filter(Boolean).length, n, wins, losses, wr, pf, net, maxDd };
}

function fmtD(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
}
function cls(v) {
  if (v == null) return '';
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : '';
}
function Stat({ label, v, cls = '', big = false }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-muted text-[10px] uppercase tracking-wide">{label}</span>
      <span className={`${cls} font-semibold ${big ? 'text-sm' : ''}`}>{v}</span>
    </span>
  );
}
