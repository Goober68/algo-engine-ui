// Runner-level control bar — process identity + lifecycle controls.
// Wired to algo-coord's POST endpoints; surfaces the safety-guard
// 409 with a force-override modal.

import { useEffect, useState } from 'react';
import { runnerControl } from '../../data/commands';

export default function RunnerControlBar({ runner, meta }) {
  const isLive = runner.status === 'live';
  const [busy, setBusy] = useState(null);
  const [guard, setGuard] = useState(null);   // {action, safety} when blocked
  const [toast, setToast] = useState(null);
  const [nssm, setNssm] = useState(null);

  // Periodic NSSM/safety status refresh (every 10s).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await runnerControl.status(runner.id);
        if (!cancelled) setNssm(s);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [runner.id]);

  const fireToast = (text, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const handle = async (action, fn) => {
    setBusy(action);
    try {
      const r = await fn();
      fireToast(`${action} → ${r.nssm_state || r.action || 'ok'}`);
    } catch (e) {
      if (e.status === 409 && e.detail?.safety) {
        setGuard({ action, safety: e.detail.safety });
      } else {
        fireToast(`${action} failed: ${e.message}`, false);
      }
    } finally {
      setBusy(null);
    }
  };

  const force = async () => {
    const action = guard.action;
    setGuard(null);
    setBusy(action);
    try {
      const fn = action === 'restart' ? () => runnerControl.restart(runner.id, true)
               : action === 'stop'    ? () => runnerControl.stop(runner.id, true)
               : null;
      const r = await fn();
      fireToast(`${action} (forced) → ${r.nssm_state || 'ok'}`);
    } catch (e) {
      fireToast(`${action} (forced) failed: ${e.message}`, false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-panel border border-border rounded relative text-xs tnum">
      <div className="flex items-center gap-3 px-3 py-1 border-b border-border">
        <span className="font-semibold text-sm">{runner.label}</span>
        <StatusPill status={runner.status} />
        <span className="text-muted">pid {runner.pid ?? '—'}</span>
        <span className="text-muted">:{runner.port}</span>
        <span className="text-muted">{runner.binary}</span>
        {nssm?.nssm_state && (
          <span className={
            nssm.nssm_state === 'SERVICE_RUNNING' ? 'text-long' :
            nssm.nssm_state === 'NSSM_UNAVAILABLE' ? 'text-muted' :
            'text-trail'
          }>{nssm.nssm_state}</span>
        )}
        <div className="ml-auto flex gap-1">
          <Btn icon="↺" label="Reconcile" disabled={busy != null}
               onClick={() => handle('reconcile', () => runnerControl.reconcileNow(runner.id))} />
          <Btn icon={isLive ? '⏸' : '▶'} label={isLive ? 'Stop' : 'Start'}
               variant={isLive ? 'warn' : 'go'} disabled={busy != null}
               onClick={() => isLive
                 ? handle('stop', () => runnerControl.stop(runner.id))
                 : handle('start', () => runnerControl.start(runner.id))} />
          <Btn icon="↻" label="Restart" disabled={busy != null}
               onClick={() => handle('restart', () => runnerControl.restart(runner.id))} />
        </div>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-3 py-1 text-[11px]">
        <KV k="config" v={runner.config_file} mono />
        <KV k="symbol" v={meta.symbol} />
        <KV k="bar"    v={`${Math.round(meta.bar_period_sec / 60)}m`} />
        <KV k="run"    v={meta.run_id} mono />
        {runner.started_at && <KV k="started" v={new Date(runner.started_at).toLocaleString()} />}
        <span className="text-muted truncate">{runner.note}</span>
      </div>

      {toast && (
        <div className={`absolute -bottom-2 right-3 translate-y-full text-xs px-2 py-1 rounded shadow ${
          toast.ok ? 'bg-long/90 text-bg' : 'bg-short/90 text-bg'
        }`}>{toast.text}</div>
      )}

      {guard && <GuardModal guard={guard} onForce={force} onCancel={() => setGuard(null)} />}
    </div>
  );
}

function GuardModal({ guard, onForce, onCancel }) {
  const blocking = guard.safety.slots.filter(s => s.blockers.length > 0);
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center" onClick={onCancel}>
      <div className="bg-panel border border-short rounded p-4 max-w-lg w-full" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-short mb-2">⊘ {guard.action} blocked by safety guard</h3>
        <p className="text-xs text-muted mb-3">
          Restarting mid-trade or mid-GTD orphans broker fills (the runner restarts
          unaware that the broker filled a pending order during the down-gap, then
          fires a NEW entry on the next bar — doubling the position).
        </p>
        <div className="space-y-2 text-xs mb-4">
          {blocking.map(s => (
            <div key={s.slot_idx} className="bg-bg p-2 rounded border border-border">
              <div className="font-semibold mb-1">Slot {s.slot_idx}</div>
              <ul className="ml-4 list-disc text-short">
                {s.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 text-xs rounded bg-bg border border-border text-muted hover:text-text" onClick={onCancel}>Cancel</button>
          <button className="px-3 py-1 text-xs rounded bg-short text-bg" onClick={onForce}>Force {guard.action}</button>
        </div>
      </div>
    </div>
  );
}

function KV({ k, v, mono = false }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted text-[10px] uppercase tracking-wide">{k}</span>
      <span className={`text-text ${mono ? 'font-mono' : ''}`}>{v}</span>
    </span>
  );
}

function StatusPill({ status }) {
  const map = {
    live:    'bg-long/20 text-long border-long/40',
    shadow:  'bg-accent/20 text-accent border-accent/40',
    offline: 'bg-muted/20 text-muted border-border',
  };
  return (
    <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wide rounded border ${map[status] || map.offline}`}>
      {status}
    </span>
  );
}

function Btn({ icon, label, variant, disabled, onClick }) {
  const cls = {
    go:     'border-long/50 text-long hover:bg-long/10',
    warn:   'border-trail/50 text-trail hover:bg-trail/10',
    danger: 'border-short/50 text-short hover:bg-short/10',
  }[variant] || 'border-border text-muted hover:text-text';
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`px-2 py-1 text-xs rounded bg-bg border ${cls} disabled:opacity-40 disabled:cursor-wait`}
    >
      <span className="mr-1">{icon}</span>{label}
    </button>
  );
}
