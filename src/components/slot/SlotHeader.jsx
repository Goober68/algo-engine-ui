// Combined slot header: identity + LIVE pill + stats + slot-scoped
// controls. One dense row instead of two.
//
// Replaces the old ControllerBar + StatsStrip pair.

import { useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { runnerControl } from '../../data/commands';

export default function SlotHeader({ slotMeta, data }) {
  const { id } = useParams();
  const stats = useMemo(() => compute(data), [data]);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);

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
      <span className="text-muted">|</span>
      <Cell label="trades" v={stats.n} />
      <Cell label="WR"     v={`${stats.wr}%`} />
      <Cell label="PF"     v={stats.pf} />
      <Cell label="net"    v={fmtD(stats.net)}   cls={cls(stats.net)} />
      <Cell label="Δ"      v={fmtD(stats.delta)} cls={cls(stats.delta)} />
      <Cell label="DD"     v={fmtD(stats.dd)}    cls="text-short" />

      <div className="ml-auto flex gap-1">
        <Btn label="Reconcile" icon="↺" disabled={busy != null} onClick={reconcile} />
        <Btn label="Config"    icon="⚙" disabled={true} title="Per-slot config edit — Pass C" />
      </div>
      {toast && (
        <div className={`absolute -bottom-2 right-3 translate-y-full text-[11px] px-2 py-0.5 rounded shadow z-10 ${
          toast.ok ? 'bg-long/90 text-bg' : 'bg-short/90 text-bg'
        }`}>{toast.text}</div>
      )}
    </div>
  );
}

function Cell({ label, v, cls = '' }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-muted text-[10px] uppercase tracking-wide">{label}</span>
      <span className={`font-semibold ${cls}`}>{v}</span>
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
