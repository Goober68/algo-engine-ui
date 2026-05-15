import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { useRunMeta, useSlotData } from '../data/MockDataProvider';
import SlotHeader from '../components/slot/SlotHeader';
import ChartPane from '../components/slot/ChartPane';
import EquityMini from '../components/slot/EquityMini';
import TradeTable from '../components/slot/TradeTable';
import LogsDrawer from '../components/slot/LogsDrawer';
// StrategyStatePanel temporarily removed from the UI (per user 2026-05-12)
// — the chart's per-bar gate hover tooltip subsumes its main purpose.
// Keep the import/JSX commented (not deleted) in case it comes back.
// import StrategyStatePanel from '../components/slot/StrategyStatePanel';
import TradeTickModal from '../components/slot/TradeTickModal';
import Splitter from '../components/chrome/Splitter';
import { usePersistedSize } from '../components/chrome/usePersistedSize';

export default function SlotView() {
  const { id, n } = useParams();
  const slotIdx = parseInt(n, 10);
  const meta = useRunMeta(id);
  const data = useSlotData(id, slotIdx);
  const slotMeta = meta?.slots.find(s => s.slot_idx === slotIdx);

  const [filter, setFilter]                       = useState('all');
  const [selectedTradeKey, setSelectedTradeKey]   = useState(null);
  const [modalTradeKey, setModalTradeKey]         = useState(null);

  // Persisted view state. tf and panel sizes survive slot/runner switches
  // + page reloads. selectedTradeKey is intentionally per-session.
  const [tf, setTf]               = usePersistedSize('slotview.tf', 180);
  const [railPx, setRailPx]      = usePersistedSize('slotview.railPx', 340);
  const [statePx, setStatePx]    = usePersistedSize('slotview.statePx', 280);
  const [equityPx, setEquityPx]  = usePersistedSize('slotview.equityPx', 96);
  const [drawerPx, setDrawerPx]  = usePersistedSize('slotview.drawerPx', 32);

  if (!meta || !data || !slotMeta) {
    return <div className="p-3 text-muted text-xs">Loading slot {slotIdx}…</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <SlotHeader slotMeta={slotMeta} data={data} />
      <div className="flex-1 min-h-0 flex">
        {/* Left: chart fills the remaining width */}
        <div className="flex-1 min-w-0 min-h-0 relative">
          <ChartPane
            data={data}
            runnerId={id}
            tf={tf}
            setTf={setTf}
            selectedTradeKey={selectedTradeKey}
            setSelectedTradeKey={(k) => { setSelectedTradeKey(k); setModalTradeKey(k); }}
            live
          />
        </div>
        <Splitter dir="col" size={railPx} setSize={setRailPx} min={220} max={700} invert />
        {/* Right rail (top→bottom): trades · equity · algo state.
            Trades flex-grow so they get the bulk of vertical space
            and so auto-scroll-to-latest stays meaningful. */}
        <div className="flex flex-col min-h-0 bg-panel2" style={{ width: railPx }}>
          <div className="flex-1 min-h-0 bg-panel">
            <TradeTable
              data={data}
              filter={filter}
              setFilter={setFilter}
              selectedTradeKey={selectedTradeKey}
              setSelectedTradeKey={(k) => { setSelectedTradeKey(k); setModalTradeKey(k); }}
            />
          </div>
          <Splitter dir="row" size={equityPx} setSize={setEquityPx} min={48} max={400} invert />
          <div className="bg-panel" style={{ height: equityPx }}>
            <EquityMini data={data} />
          </div>
          {/* StrategyStatePanel removed — keep markup for easy revival.
              <Splitter dir="row" size={statePx} setSize={setStatePx} min={120} max={600} invert />
              <div className="overflow-y-auto bg-panel2" style={{ height: statePx }}>
                <StrategyStatePanel data={data} />
              </div> */}
        </div>
      </div>
      <Splitter dir="row" size={drawerPx} setSize={setDrawerPx} min={28} max={500} invert />
      <div style={{ height: drawerPx }}>
        <LogsDrawer
          slotIdx={slotIdx}
          drawerPx={drawerPx}
          setDrawerPx={setDrawerPx}
          data={data}
          setSelectedTradeKey={(k) => { setSelectedTradeKey(k); setModalTradeKey(k); }}
        />
      </div>
      {modalTradeKey != null && (
        <TickModalWrapper
          data={data}
          modalTradeKey={modalTradeKey}
          onClose={() => setModalTradeKey(null)}
          onJump={(key) => setModalTradeKey(key)}
        />
      )}
    </div>
  );
}

// Resolves the trade + matching decision from data + the selected key,
// wires prev/next navigation across the broker trades array.
function TickModalWrapper({ data, modalTradeKey, onClose, onJump }) {
  // Resolve the clicked key from EITHER source, then fall back to
  // ad-hoc (the modalTradeKey itself is just a ts in ns -- a bar
  // click on an empty bar, e.g.). Ad-hoc opens the modal in inspect-
  // only mode: ticks visible, no entry/exit markers, no bracket lines.
  const brokerHit = (data.broker || []).find(t => t.entry_ts === modalTradeKey);
  const algoHit   = brokerHit ? null
    : (data.trades || []).find(t => t.entry_ts === modalTradeKey);
  const focal     = brokerHit || algoHit
    || { ad_hoc: true, ts_ns: modalTradeKey, entry_ts: modalTradeKey,
         entry_px: null, side: null, qty: 0 };

  // Counterpart from the OTHER source (only meaningful when focal is
  // a real trade, not an ad-hoc bar click).
  const brokerTrade = brokerHit || (focal.ad_hoc ? null : nearestPair(data.broker, focal));
  const algoTrade   = algoHit   || (focal.ad_hoc ? null : nearestPair(data.trades || [], focal));

  // Match decision + audit only for real trades.
  const TF = 180;
  let decision = null;
  let audit = null;
  let trailArm = null;
  if (!focal.ad_hoc) {
    const entrySec = Math.floor(focal.entry_ts / 1e9);
    const barSec   = Math.floor(entrySec / TF) * TF;
    decision = data.decisions?.find(d =>
      Math.floor(d.ts_ns / 1e9 / TF) * TF === barSec);
    audit = findAuditForTrade(data.audit || [], focal);
    // Trail arm: match by (order_id when available, else by side+qty
    // within the trade's [entry_ts, exit_ts] window). Engine emits
    // one arm per fill that crosses the hysteresis threshold; if the
    // trade exited before arming, this is null.
    trailArm = findTrailArmForTrade(data.trail_arms || [], focal,
                                    audit, brokerTrade, algoTrade);
  }

  // Prev/next nav walks ALGO order bars only (data.trades sorted by
  // entry_ts). The "next algo bar" from any starting point -- even an
  // ad-hoc bar click or a broker-only fill -- is the next algo
  // entry_ts strictly after the current key.
  const algoSorted = (data.trades || []).slice().sort((a, b) => a.entry_ts - b.entry_ts);
  const prev = algoSorted.filter(t => t.entry_ts < modalTradeKey).pop();
  const next = algoSorted.find(t => t.entry_ts > modalTradeKey);

  return (
    <TradeTickModal
      trade={focal}
      brokerTrade={brokerTrade}
      algoTrade={algoTrade}
      decision={decision}
      audit={audit}
      trailArm={trailArm}
      onClose={onClose}
      onPrev={prev ? () => onJump(prev.entry_ts) : null}
      onNext={next ? () => onJump(next.entry_ts) : null}
    />
  );
}

// Find the trade in `pool` closest to `target`, side + qty matched,
// within a 5-min window. Used to pair broker<->algo counterparts.
function nearestPair(pool, target) {
  const WIN_NS = 5 * 60 * 1_000_000_000;
  let best = null, bestD = Infinity;
  for (const t of pool) {
    if (t.side !== target.side || t.qty !== target.qty) continue;
    const d = Math.abs(t.entry_ts - target.entry_ts);
    if (d > WIN_NS) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// Walk audit POSTs and find the one that caused this broker fill.
// Side must match; quantity must match; the POST timestamp should
// precede the fill by at most one GTD window (3 min + a small buffer).
// Returns the closest-by-time match.
function findAuditForTrade(audits, trade) {
  const MAX_AHEAD_NS = 5 * 60 * 1_000_000_000;     // 5 min
  const MAX_BEHIND_NS = 5 * 1_000_000_000;         // 5 s (clock skew)
  let best = null;
  let bestD = Infinity;
  for (const a of audits) {
    const req = a.request || {};
    const action = (req.action || '').toLowerCase();
    const aSide = action.includes('buy') ? 'long' : action.includes('sell') ? 'short' : null;
    if (aSide !== trade.side) continue;
    if (Number(req.quantity) !== trade.qty) continue;
    const delta = trade.entry_ts - a.ts_ns;
    if (delta < -MAX_BEHIND_NS || delta > MAX_AHEAD_NS) continue;
    if (Math.abs(delta) < bestD) {
      bestD = Math.abs(delta);
      best = a;
    }
  }
  return best;
}

// Walk trail-arm events and find the one that armed for this trade.
// Engine stamps each arm with order_id (= the broker's order id from
// the algo's POST). When that's available on the broker fill it's a
// clean exact match; otherwise fall back to "arm fired between
// entry_ts and exit_ts, side matches via signed qty (long=+,short=-),
// |qty| matches". Returns the arm event or null (= trade exited
// before the trail armed).
function findTrailArmForTrade(arms, trade, audit, brokerTrade, algoTrade) {
  if (!arms || !arms.length || !trade.entry_ts) return null;
  const exitTs = trade.exit_ts || (trade.entry_ts + 24 * 60 * 60 * 1e9);
  // First try order_id match. Broker fills may carry an order_id;
  // audit POST request body may carry algo_signal_id we don't track.
  const oid = brokerTrade?.order_id ?? algoTrade?.order_id;
  if (oid != null) {
    const exact = arms.find(a => a.order_id === oid);
    if (exact) return exact;
  }
  // Fall back to time + side + qty match within the trade's window.
  const wantQty = trade.qty;
  const wantLong = trade.side === 'long';
  for (const a of arms) {
    if (a.ts_ns < trade.entry_ts || a.ts_ns > exitTs) continue;
    const armIsLong = (a.qty || 0) > 0;
    if (armIsLong !== wantLong) continue;
    if (Math.abs(a.qty) !== Math.abs(wantQty)) continue;
    return a;
  }
  return null;
}
