import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { useRunMeta, useSlotData } from '../data/MockDataProvider';
import SlotHeader from '../components/slot/SlotHeader';
import ChartPane from '../components/slot/ChartPane';
import EquityMini from '../components/slot/EquityMini';
import TradeTable from '../components/slot/TradeTable';
import LogsDrawer from '../components/slot/LogsDrawer';
import StrategyStatePanel from '../components/slot/StrategyStatePanel';
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
          <Splitter dir="row" size={statePx} setSize={setStatePx} min={120} max={600} invert />
          <div className="overflow-y-auto bg-panel2" style={{ height: statePx }}>
            <StrategyStatePanel data={data} />
          </div>
        </div>
      </div>
      <Splitter dir="row" size={drawerPx} setSize={setDrawerPx} min={28} max={500} invert />
      <div style={{ height: drawerPx }}>
        <LogsDrawer slotIdx={slotIdx} drawerPx={drawerPx} setDrawerPx={setDrawerPx} />
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
  const trade = data.broker.find(t => t.entry_ts === modalTradeKey);
  if (!trade) { onClose(); return null; }

  // Match decision by snapping entry to the bar boundary.
  const TF = 180;
  const entrySec = Math.floor(trade.entry_ts / 1e9);
  const barSec   = Math.floor(entrySec / TF) * TF;
  const decision = data.decisions?.find(d =>
    Math.floor(d.ts_ns / 1e9 / TF) * TF === barSec);

  // Match the audit (webhook POST) that produced this fill. Pair on
  // side+qty within a generous forward window (the POST goes out at
  // bar close; the limit fills sometime later inside its GTD window).
  // Pick the nearest unfilled-by-time audit before the entry.
  const audit = findAuditForTrade(data.audit || [], trade);

  const sorted = [...data.broker].sort((a, b) => a.entry_ts - b.entry_ts);
  const idx = sorted.findIndex(t => t.entry_ts === modalTradeKey);
  const prev = idx > 0                ? sorted[idx - 1] : null;
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;

  return (
    <TradeTickModal
      trade={trade}
      decision={decision}
      audit={audit}
      onClose={onClose}
      onPrev={prev ? () => onJump(prev.entry_ts) : null}
      onNext={next ? () => onJump(next.entry_ts) : null}
    />
  );
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
