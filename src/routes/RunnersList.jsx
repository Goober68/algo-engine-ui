import { Link } from 'react-router-dom';
import { useRunners, useRunMeta, useSlotData } from '../data/MockDataProvider';

export default function RunnersList() {
  const runners = useRunners();
  if (!runners) return <div className="p-4 text-muted">Loading runners…</div>;
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold">Runners</h2>
        <button
          className="px-3 py-1 text-xs rounded bg-accent text-bg"
          onClick={() => alert('+ Runner — mock; wired in Phase 2')}
        >
          + Runner
        </button>
      </div>
      <div className="space-y-2">
        {runners.map(r => <RunnerRow key={r.id} runner={r} />)}
      </div>
    </div>
  );
}

function RunnerRow({ runner }) {
  const meta = useRunMeta(runner.id);
  return (
    <Link
      to={`/r/${runner.id}`}
      className="block bg-panel border border-border rounded p-3 hover:border-accent"
    >
      <div className="flex items-start gap-3">
        <StatusDot status={runner.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">{runner.label}</span>
            <span className="text-xs text-muted tnum">pid {runner.pid ?? '—'}</span>
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted tnum">:{runner.port}</span>
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted tnum">{runner.binary}</span>
          </div>
          <div className="text-[11px] text-muted mt-0.5 tnum">{runner.config_file}</div>
          <div className="text-xs text-muted mt-1">{runner.note}</div>
          {meta && (
            <div className="text-xs text-muted mt-2 flex gap-4 tnum">
              <span>{meta.slots.length} slots</span>
              <span>·</span>
              <span>{meta.symbol}</span>
              <span>·</span>
              <span>{Math.round(meta.bar_period_sec / 60)}m bars</span>
              {runner.started_at && (
                <>
                  <span>·</span>
                  <span>started {fmtAgo(runner.started_at)}</span>
                </>
              )}
            </div>
          )}
        </div>
        <SlotMiniGrid runner={runner} meta={meta} />
      </div>
    </Link>
  );
}

function SlotMiniGrid({ runner, meta }) {
  if (!meta) return null;
  return (
    <div className="flex gap-1">
      {meta.slots.map(s => (
        <SlotMiniCell key={s.slot_idx} runnerId={runner.id} slot={s} />
      ))}
    </div>
  );
}

function SlotMiniCell({ runnerId, slot }) {
  const data = useSlotData(runnerId, slot.slot_idx);
  if (!data) return <div className="w-16 h-12 bg-bg border border-border rounded animate-pulse" />;
  const net = data.broker.reduce((s, t) => s + t.pnl, 0);
  const cls = net > 0 ? 'text-long' : net < 0 ? 'text-short' : 'text-text';
  return (
    <div className="w-16 h-12 bg-bg border border-border rounded p-1 text-[10px] tnum">
      <div className="text-muted">slot {slot.slot_idx}</div>
      <div className={`text-right font-semibold ${cls}`}>
        {net >= 0 ? '+' : ''}{net.toFixed(0)}
      </div>
      <div className="text-right text-muted">{data.broker.length}t</div>
    </div>
  );
}

function StatusDot({ status }) {
  const map = { live: 'bg-long', shadow: 'bg-accent', offline: 'bg-muted' };
  return <span className={`w-2 h-2 rounded-full mt-2 ${map[status] || 'bg-muted'}`} />;
}

function fmtAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
