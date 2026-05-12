// Cross-slot equity curve comparison — one line per slot (sim) +
// optionally one dashed line per slot (broker). 6 lines max. Color per
// slot. Time-aligned via UTC timestamps; X axis = trade index for now
// (real time-aligned x-axis lifts when we have a unified bar timeline
// across runners).

import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';

const SLOT_COLORS = ['#5fa8ff', '#ffb300', '#d39de4'];   // slot 0/1/2

export default function CompareEquity({ meta, slotsData }) {
  const [showBroker, setShowBroker] = useState(true);
  const [showSim, setShowSim] = useState(true);
  const series = useMemo(() => buildSeries(slotsData), [slotsData]);
  return (
    <div className="bg-panel border border-border rounded p-2">
      <div className="flex items-center gap-3 text-[11px] text-muted mb-1">
        <span className="text-[10px] uppercase tracking-wide">cross-slot equity</span>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={showSim} onChange={() => setShowSim(v => !v)} />
          sim
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={showBroker} onChange={() => setShowBroker(v => !v)} />
          broker (dashed)
        </label>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 16, left: 8, bottom: 24 }}>
            <XAxis dataKey="i" tick={{ fill: '#7c8190', fontSize: 10 }} stroke="#2a2e36" />
            <YAxis tick={{ fill: '#7c8190', fontSize: 10 }} stroke="#2a2e36" />
            <Tooltip
              contentStyle={{ background: '#1a1d23', border: '1px solid #2a2e36', fontSize: 11 }}
              labelStyle={{ color: '#7c8190' }}
              formatter={(v, n) => [`$${Number(v).toFixed(2)}`, n]}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#7c8190' }} />
            <ReferenceLine y={0} stroke="#2a2e36" strokeDasharray="2 2" />
            {meta.slots.map((s, i) => (
              <Line
                key={`sim${i}`}
                hide={!showSim}
                type="monotone"
                dataKey={`sim_${i}`}
                name={`slot ${i} sim`}
                stroke={SLOT_COLORS[i]}
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            ))}
            {meta.slots.map((s, i) => (
              <Line
                key={`br${i}`}
                hide={!showBroker}
                type="monotone"
                dataKey={`br_${i}`}
                name={`slot ${i} broker`}
                stroke={SLOT_COLORS[i]}
                strokeOpacity={0.7}
                dot={false}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function buildSeries(slotsData) {
  const N = Math.max(...slotsData.map(d => Math.max(d?.trades.length || 0, d?.broker.length || 0)));
  const out = [];
  const simEq = slotsData.map(() => 0);
  const brEq  = slotsData.map(() => 0);
  for (let i = 0; i < N; i++) {
    const row = { i };
    slotsData.forEach((d, k) => {
      if (d) {
        if (d.trades[i]) simEq[k] += d.trades[i].pnl;
        if (d.broker[i]) brEq[k]  += d.broker[i].pnl;
      }
      row[`sim_${k}`] = simEq[k];
      row[`br_${k}`]  = brEq[k];
    });
    out.push(row);
  }
  return out;
}
