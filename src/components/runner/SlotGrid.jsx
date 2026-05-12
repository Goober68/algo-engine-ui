// Denser per-slot cards with embedded equity sparkline. Click drills
// into the slot view.

import { Link } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, ReferenceLine } from 'recharts';

export default function SlotGrid({ runnerId, meta, slotsData }) {
  return (
    <div className="flex flex-col gap-2">
      {meta.slots.map((s, i) => (
        <SlotCard key={s.slot_idx} runnerId={runnerId} slot={s} data={slotsData[i]} />
      ))}
    </div>
  );
}

function SlotCard({ runnerId, slot, data }) {
  const summary = computeSummary(data);
  return (
    <Link
      to={`/r/${runnerId}/s/${slot.slot_idx}`}
      className="block bg-panel border border-border rounded p-2 hover:border-accent transition-colors text-xs tnum"
    >
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-semibold">Slot {slot.slot_idx}</span>
        <span className="text-muted">{slot.account}</span>
        <span className="text-muted truncate text-[11px]">· {slot.label}</span>
      </div>
      <div className="grid grid-cols-6 gap-x-2 gap-y-0.5">
        <Stat label="net"    v={fmtD(summary.net)}   cls={cls(summary.net)} />
        <Stat label="trades" v={summary.n} />
        <Stat label="WR"     v={`${summary.wr}%`} />
        <Stat label="PF"     v={summary.pf} />
        <Stat label="Δ"      v={fmtD(summary.delta)} cls={cls(summary.delta)} />
        <Stat label="DD"     v={fmtD(summary.dd)}    cls="text-short" />
      </div>
      <div className="h-10 -mx-1 mt-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={summary.spark} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <ReferenceLine y={0} stroke="#2a2e36" strokeDasharray="2 2" />
            <Line type="monotone" dataKey="eq"
                  stroke={summary.net >= 0 ? '#26a69a' : '#ef5350'}
                  dot={false} strokeWidth={1.2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Link>
  );
}

function computeSummary(data) {
  if (!data) return { n: 0, net: 0, wr: 0, pf: '—', delta: 0, dd: 0, spark: [] };
  const { trades, broker } = data;
  const n = broker.length;
  const wins = broker.filter(t => t.pnl > 0).length;
  const gw = broker.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = broker.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const pf = gl < 0 ? (gw / -gl).toFixed(2) : '∞';
  const wr = n ? Math.round((wins / n) * 100) : 0;
  const net = broker.reduce((s, t) => s + t.pnl, 0);
  const sim = trades.reduce((s, t) => s + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  const spark = [{ i: 0, eq: 0 }];
  for (let i = 0; i < broker.length; i++) {
    eq += broker[i].pnl;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
    spark.push({ i: i + 1, eq });
  }
  return { n, net, sim, delta: sim - net, wr, pf, dd, spark };
}

function fmtD(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(0);
}
function cls(v) {
  if (v == null) return '';
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : '';
}
function Stat({ label, v, cls = '' }) {
  return (
    <div className="leading-tight">
      <div className="text-muted text-[10px] uppercase tracking-wide">{label}</div>
      <div className={`${cls} font-semibold`}>{v}</div>
    </div>
  );
}
