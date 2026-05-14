// Tight equity strip: algo (dotted + dimmed = desired outcome) vs
// broker (solid = actual outcome). Curve color reflects the SIGN of
// the window-end value -- green when the period is up, red when
// down -- so a single glance tells you "did this slot make money or
// lose money this window". Algo and broker pick their signs
// independently (slippage can flip one without the other).

import { LineChart, Line, ResponsiveContainer, ReferenceLine, XAxis, YAxis, Tooltip } from 'recharts';
import { useMemo } from 'react';

const POS_COLOR    = '#22c55e';   // green-500 -> period up
const NEG_COLOR    = '#ef4444';   // red-500   -> period down
const ALGO_OPACITY = 0.55;

export default function EquityMini({ data }) {
  const series = useMemo(() => buildEquity(data), [data]);
  const last   = series.length ? series[series.length - 1] : { algo: 0, broker: 0 };
  const algoColor   = (last.algo   ?? 0) >= 0 ? POS_COLOR : NEG_COLOR;
  const brokerColor = (last.broker ?? 0) >= 0 ? POS_COLOR : NEG_COLOR;
  return (
    <div className="w-full h-full px-2 pt-1 pb-0.5 flex flex-col">
      <div className="flex items-baseline justify-between text-[10px] text-muted tnum mb-0.5">
        <span className="flex items-center gap-2">
          <span>EQUITY</span>
          <LegendItem label="algo"   color={algoColor}   opacity={ALGO_OPACITY} dashed />
          <LegendItem label="broker" color={brokerColor} />
        </span>
        <span>
          <span style={{ color: algoColor, opacity: ALGO_OPACITY }}>{fmt(last.algo)}</span>
          {' · '}
          <span style={{ color: brokerColor }}>{fmt(last.broker)}</span>
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 2, right: 6, left: 4, bottom: 0 }}>
            <XAxis
              dataKey="ts" type="number" scale="time"
              domain={['dataMin', 'dataMax']}
              hide
            />
            <YAxis
              width={36}
              tick={{ fill: '#7c8190', fontSize: 9 }}
              tickFormatter={fmtYAxis}
              domain={['dataMin', 'dataMax']}
              axisLine={{ stroke: '#2a2e36' }}
              tickLine={{ stroke: '#2a2e36' }}
            />
            <ReferenceLine y={0} stroke="#2a2e36" strokeDasharray="2 2" />
            <Tooltip
              contentStyle={{ background: '#1a1d23', border: '1px solid #2a2e36', fontSize: 10, padding: '4px 6px' }}
              labelStyle={{ color: '#7c8190' }}
              labelFormatter={(ts) => new Date(ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
              formatter={(v, name) => [v == null ? '—' : `$${Number(v).toFixed(2)}`, name]}
            />
            <Line type="linear" dataKey="algo"   stroke={algoColor}   strokeOpacity={ALGO_OPACITY} strokeDasharray="2 3" dot={false} strokeWidth={1.4} isAnimationActive={false} connectNulls />
            <Line type="linear" dataKey="broker" stroke={brokerColor} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LegendItem({ label, color, opacity = 1, dashed }) {
  return (
    <span className="inline-flex items-center gap-1" style={{ opacity }}>
      <svg width="14" height="3">
        <line x1="0" y1="1.5" x2="14" y2="1.5"
              stroke={color} strokeWidth="1.4"
              strokeDasharray={dashed ? '2 3' : undefined} />
      </svg>
      <span style={{ color }}>{label}</span>
    </span>
  );
}

// Build a time-indexed equity curve, last 24h only. Each event (trade
// exit OR broker fill) contributes a step at its exit timestamp.
// Both series share the merged time axis so they line up visually.
//
// Both curves anchored at $0 at the window's left edge, regardless of
// pre-window cumulative P&L. The point of viewing them together is to
// see "how is sim doing vs broker SINCE THE WINDOW OPENED" -- absolute
// histories carried in from before would put the two on opposite sides
// of the y-axis and make the delta unreadable. The header readout
// shows the window-relative final value to match the curve.
function buildEquity({ trades = [], broker = [] }) {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const events = [];
  for (const t of trades) {
    if (t.pnl == null || !t.exit_ts) continue;
    const ms = t.exit_ts / 1e6;
    if (ms < cutoffMs) continue;
    events.push({ ts: ms, kind: 'algo', pnl: t.pnl });
  }
  for (const b of broker) {
    if (b.pnl == null || !b.exit_ts) continue;
    const ms = b.exit_ts / 1e6;
    if (ms < cutoffMs) continue;
    events.push({ ts: ms, kind: 'broker', pnl: b.pnl });
  }
  events.sort((a, b) => a.ts - b.ts);

  let algoEq = 0, brEq = 0;
  const out = [{ ts: cutoffMs, algo: 0, broker: 0 }];
  for (const e of events) {
    if (e.kind === 'algo')   algoEq += e.pnl;
    if (e.kind === 'broker') brEq   += e.pnl;
    out.push({ ts: e.ts, algo: algoEq, broker: brEq });
  }
  return out;
}

function fmt(v) {
  const n = v ?? 0;
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
}
// Compact Y-axis labels: $1k, $1.2k etc. Bare dollars below 1k.
function fmtYAxis(v) {
  const n = Math.round(v);
  if (Math.abs(n) >= 1000) return (n >= 0 ? '$' : '-$') + (Math.abs(n) / 1000).toFixed(1) + 'k';
  return (n >= 0 ? '$' : '-$') + Math.abs(n);
}
