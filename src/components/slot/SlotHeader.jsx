// Combined slot header: identity + LIVE pill + stats + slot-scoped
// controls. One dense row instead of two.
//
// Replaces the old ControllerBar + StatsStrip pair.

import { useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { runnerControl } from '../../data/commands';
import { useActiveCoord } from '../../data/coords';
import { useBrokerTruthStatus } from '../../data/brokerTruthClient';
import SlotConfigDrawer from './SlotConfigDrawer';

// Stale threshold matches coord's poll_interval_sec (60s) + one tick of
// slack -- inside this window we trust the displayed broker $; outside,
// we dim it so users know the number isn't being refreshed.
const STALE_AFTER_SEC = 120;

export default function SlotHeader({ slotMeta, data }) {
  const { id } = useParams();
  const stats = useMemo(() => compute(data), [data]);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const coord = useActiveCoord('runners');
  const truth = useBrokerTruthStatus(slotMeta.account, coord?.url);
  const truthHealth = classifyTruth(truth);
  const [configOpen, setConfigOpen] = useState(false);

  const fireToast = (text, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 2500);
  };

  const reconcile = async () => {
    setBusy('reconcile');
    try {
      // Scope to just this slot's account so we don't pull all 3.
      const r = await runnerControl.reconcileNow(id, slotMeta.account);
      const res = r.results?.[0];
      if (res?.ok) {
        fireToast(`reconcile · ${res.n_trades} trades · ${res.elapsed_sec}s`);
      } else {
        fireToast(`reconcile failed: ${res?.error || 'unknown'}`, false);
      }
    } catch (e) {
      fireToast(`reconcile failed: ${e.message}`, false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative bg-panel border-b border-border px-3 py-1 flex items-center gap-3 text-xs tnum">
      <span className="font-semibold text-sm">Slot {slotMeta.slot_idx}</span>
      <span className="text-muted">·</span>
      <span>{slotMeta.account}</span>
      <span className="text-muted truncate max-w-[160px]">{slotMeta.label}</span>
      {slotMeta.live && (
        <span className="px-1.5 py-px text-[10px] rounded bg-long/20 text-long border border-long/40">
          LIVE
        </span>
      )}
      <BrokerHealthPill health={truthHealth} />
      <span className="text-muted">|</span>
      <Cell label="trades" v={stats.n} />
      <Cell label="WR"     v={`${stats.wr}%`} />
      <Cell label="PF"     v={stats.pf} />
      <Cell label="net"
            v={fmtD(stats.net)}
            cls={cls(stats.net)}
            stale={truthHealth.kind !== 'ok'}
            staleTitle={truthHealth.tooltip} />
      <Cell label="Δ"      v={fmtD(stats.delta)} cls={cls(stats.delta)} />
      <Cell label="DD"     v={fmtD(stats.dd)}    cls="text-short" />

      <div className="ml-auto flex gap-1">
        <Btn label="Reconcile" icon="↺" disabled={busy != null} onClick={reconcile} />
        <Btn label="Config"    icon="⚙" onClick={() => setConfigOpen(true)}
             title="Edit this slot's strategy config" />
      </div>
      {toast && (
        <div className={`absolute -bottom-2 right-3 translate-y-full text-[11px] px-2 py-0.5 rounded shadow z-10 ${
          toast.ok ? 'bg-long/90 text-bg' : 'bg-short/90 text-bg'
        }`}>{toast.text}</div>
      )}
      {configOpen && (
        <SlotConfigDrawer
          runnerId={id}
          slotIdx={slotMeta.slot_idx}
          account={slotMeta.account}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </div>
  );
}

function Cell({ label, v, cls = '', stale = false, staleTitle = '' }) {
  return (
    <span className="flex items-baseline gap-1" title={stale ? staleTitle : undefined}>
      <span className="text-muted text-[10px] uppercase tracking-wide">{label}</span>
      <span className={`font-semibold ${stale ? 'opacity-40 line-through decoration-1' : cls}`}>
        {v}
      </span>
    </span>
  );
}

// Maps the raw poller status into one of three states + a pre-built
// tooltip string so the consumers (pill + stale-cell title) share one
// vocabulary.
function classifyTruth({ status, pollerError } = {}) {
  if (pollerError) {
    return { kind: 'err', label: '?', color: 'short',
             tooltip: `broker poller unreachable: ${pollerError}` };
  }
  if (!status) {
    return { kind: 'err', label: '?', color: 'short',
             tooltip: 'no broker_truth status for this account' };
  }
  if (!status.last_ok) {
    return { kind: 'err', label: 'x', color: 'short',
             tooltip: `broker poll failed: ${status.last_error || 'unknown'}` };
  }
  if (status.age_sec == null || status.age_sec > STALE_AFTER_SEC) {
    return { kind: 'stale', label: '!', color: 'amber',
             tooltip: `broker truth stale (${status.age_sec?.toFixed(0) ?? '?'}s since last refresh)` };
  }
  return { kind: 'ok', label: '✓', color: 'long',
           tooltip: `broker truth ok (${status.last_n_trades ?? 0} trades, ${status.age_sec.toFixed(0)}s ago)` };
}

function BrokerHealthPill({ health }) {
  const palette = {
    long:  'bg-long/20 text-long border-long/40',
    short: 'bg-short/20 text-short border-short/40',
    amber: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  }[health.color] || 'bg-bg text-muted border-border';
  return (
    <span title={health.tooltip}
          className={`px-1.5 py-px text-[10px] rounded border tnum ${palette}`}>
      bkr {health.label}
    </span>
  );
}

function Btn({ icon, label, disabled, onClick, title }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="px-2 py-0.5 rounded bg-bg border border-border hover:border-accent text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed text-[11px]"
    >
      <span className="mr-1">{icon}</span>{label}
    </button>
  );
}

function compute({ trades = [], broker = [] }) {
  const n = broker.length;
  const wins = broker.filter(t => t.pnl > 0).length;
  const gw = broker.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = broker.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const pf = gl < 0 ? (gw / -gl).toFixed(2) : '∞';
  const wr = n ? Math.round((wins / n) * 100) : 0;
  const net = broker.reduce((s, t) => s + t.pnl, 0);
  const sim = trades.reduce((s, t) => s + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of broker) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return { n, wr, pf, net, delta: sim - net, dd };
}

function fmtD(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(0);
}
function cls(v) {
  if (v == null) return '';
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : '';
}
