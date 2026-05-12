// Strategy state snapshot — denser pass.
// Three sub-panels: live tick, current state, last decision gate
// breakdown. Live tick parses the runner's stdout [status] line via
// the log_stdout SSE stream.

import { useParams } from 'react-router-dom';
import { useLiveTick } from '../../data/MockDataProvider';

const LAYERS = ['infrastructure', 'session', 'algo', 'trading'];

export default function StrategyStatePanel({ data }) {
  const { id: runnerId } = useParams();
  const tick = useLiveTick(runnerId);
  if (!data?.decisions?.length) return null;
  const last = data.decisions[data.decisions.length - 1];
  return (
    <div className="flex flex-col text-xs tnum">
      <LiveTick tick={tick} />
      <CurrentState last={last} />
      <LastDecision last={last} />
    </div>
  );
}

function LiveTick({ tick }) {
  if (!tick) {
    return (
      <div className="px-2 py-1 border-b border-border bg-bg/40 text-muted text-[11px] italic">
        waiting for ticks…
      </div>
    );
  }
  const ageSec = (Date.now() - tick.ts) / 1000;
  const stale = ageSec > 5;
  const spread = tick.ask - tick.bid;
  return (
    <div className={`px-2 py-1 border-b border-border ${stale ? 'bg-trail/10' : 'bg-long/5'} flex items-baseline gap-3`}>
      <span className="text-[10px] uppercase tracking-wide text-muted">tick</span>
      <span className="text-text font-semibold">
        <span className="text-short">{tick.bid.toFixed(2)}</span>
        <span className="text-muted mx-1">/</span>
        <span className="text-long">{tick.ask.toFixed(2)}</span>
      </span>
      <span className="text-muted text-[11px]">spread {spread.toFixed(2)}</span>
      <span className="ml-auto text-[10px] text-muted">
        {tick.ticks.toLocaleString()} ticks · {tick.bars} bars
        {tick.reconnects > 0 && <span className="text-trail ml-1">· {tick.reconnects} reconn</span>}
      </span>
      {stale && <span className="text-trail text-[10px]">·{ageSec.toFixed(0)}s old</span>}
    </div>
  );
}

function CurrentState({ last }) {
  const x = last.xovd;
  const hasPos = last.open_qty !== 0;
  return (
    <div className="border-b border-border">
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted bg-bg/40 flex items-baseline justify-between">
        <span>state</span>
        <span className="text-text">bar #{last.bar_idx}</span>
      </div>
      <div className="px-2 py-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        <KV k="state"    v={x.state} accent />
        <KV k="position" v={hasPos ? `${last.open_qty > 0 ? 'L' : 'S'}${Math.abs(last.open_qty)}` : 'flat'}
            cls={hasPos ? (last.open_qty > 0 ? 'text-buy' : 'text-sell') : 'text-muted'} />
        <KV k="close"   v={fmt(x.close)} />
        <KV k="prev"    v={fmt(x.prev_close)} muted />
        <KV k="fast MA" v={fmt(x.fast_ma)} />
        <KV k="slow MA" v={fmt(x.slow_ma)} />
        <KV k="ATR"     v={x.atr.toFixed(2)} />
        <KV k="Δ MA"    v={(x.fast_ma - x.slow_ma).toFixed(2)}
            cls={x.fast_ma > x.slow_ma ? 'text-long' : 'text-short'} />
        <KV k="bars +x↑" v={x.bars_after_x_up} />
        <KV k="bars +x↓" v={x.bars_after_x_dn} />
        <KV k="above"   v={x.bars_above_short} />
        <KV k="below"   v={x.bars_below_short} />
      </div>
      {(last.entry_limit > 0 || last.sl_ticks > 0) && (() => {
        const TICK = 0.25;
        const isLong = last.open_qty > 0;
        const dir = isLong ? 1 : -1;
        const e = last.entry_limit || 0;
        const sl = e ? e - dir * (last.sl_ticks || 0) * TICK : 0;
        const tp = e ? e + dir * (last.tp_ticks || 0) * TICK : 0;
        const tsTrig = e ? e + dir * (last.trail_trigger_ticks || 0) * TICK : 0;
        return (
          <div className="px-2 py-1 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-border">
            <KV k="entry" v={e ? fmt(e) : '—'} accent />
            <KV k="qty"   v={last.contracts || '—'} muted={!last.contracts} />
            <KV k="SL"    v={last.sl_ticks ? `${fmt(sl)}` : '—'} cls={last.sl_ticks ? 'text-sl' : ''} />
            <KV k="TP"    v={last.tp_ticks ? `${fmt(tp)}` : '—'} cls={last.tp_ticks ? 'text-tp' : ''} />
            <KV k="TS @"  v={last.trail_trigger_ticks ? `${fmt(tsTrig)}` : '—'} cls={last.trail_trigger_ticks ? 'text-trail' : ''} />
            <KV k="trail" v={last.trail_dist_ticks ? `${last.trail_dist_ticks}t` : '—'} muted={!last.trail_dist_ticks} />
          </div>
        );
      })()}
    </div>
  );
}

function LastDecision({ last }) {
  const blocked = last.blocked_layer && last.blocked_layer !== 'none';
  const blockedIdx = blocked ? LAYERS.indexOf(last.blocked_layer) : LAYERS.length;
  const failGate = blocked ? last[`${last.blocked_layer}_gate`] : null;
  return (
    <div>
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted bg-bg/40 flex items-baseline justify-between">
        <span>decision</span>
        <span className="text-muted">{fmtTime(last.ts_ns)}</span>
      </div>
      <div className="px-2 py-1 space-y-0">
        {LAYERS.map((layer, i) => {
          const passed = !blocked || i < blockedIdx;
          const isFailing = blocked && i === blockedIdx;
          const skipped = blocked && i > blockedIdx;
          return (
            <GateRow key={layer} layer={layer} passed={passed} isFailing={isFailing} skipped={skipped}
                     failGate={isFailing ? failGate : null} />
          );
        })}
        <div className="mt-1 pt-1 border-t border-border flex items-center text-xs">
          <span className="text-muted text-[10px] uppercase tracking-wide">outcome</span>
          <span className="ml-auto">
            {last.order_placed >= 0
              ? <span className="text-long font-semibold">order placed</span>
              : last.is_warmup
              ? <span className="text-muted">warmup</span>
              : blocked
              ? <span className="text-short font-semibold">blocked</span>
              : <span className="text-muted">no signal</span>
            }
          </span>
        </div>
      </div>
    </div>
  );
}

function GateRow({ layer, passed, isFailing, skipped, failGate }) {
  let icon, cls, detail;
  if (skipped)        { icon = '·'; cls = 'text-muted/40'; detail = ''; }
  else if (isFailing) { icon = '⊘'; cls = 'text-short';    detail = failGate || ''; }
  else if (passed)    { icon = '✓'; cls = 'text-long';     detail = ''; }
  else                { icon = '·'; cls = 'text-muted';    detail = ''; }
  return (
    <div className="flex items-baseline gap-2 leading-tight">
      <span className={`${cls} w-3 text-center`}>{icon}</span>
      <span className={`${cls} w-24`}>{layer}</span>
      <span className="text-muted truncate text-[11px]">{detail}</span>
    </div>
  );
}

function KV({ k, v, cls = '', accent = false, muted = false }) {
  const valCls = cls || (accent ? 'text-accent' : muted ? 'text-muted' : 'text-text');
  return (
    <div className="flex items-baseline gap-1 leading-tight">
      <span className="text-muted shrink-0 text-[10px] uppercase tracking-wide">{k}</span>
      <span className={`${valCls} ml-auto`}>{v}</span>
    </div>
  );
}

function fmt(n) { return n == null ? '—' : n.toFixed(2); }
function fmtTime(ns) {
  return new Date(ns / 1e6).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
