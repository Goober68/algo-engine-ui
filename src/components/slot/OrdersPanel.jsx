// Standalone view of every relay-audit POST for a slot. Surfaces the
// orphan rows TradeTable doesn't show -- POSTs that errored, were
// cap-suppressed, or that the broker never filled.
//
// Each row:
//   ts | side qty | status | signal_id | matched? | reason
// Click a row -> if a matching broker fill exists, jump to its tick
// modal via setSelectedTradeKey. Orphan rows render as click-through
// to the audit's own JSON (modal opens on the algo-side trade pairing
// when we have one; falls back to the audit timestamp + a placeholder
// modal when not).

import { useMemo } from 'react';

const MATCH_AHEAD_NS  = 5 * 60 * 1_000_000_000;   // 5 min forward
const MATCH_BEHIND_NS = 30 * 1_000_000_000;       // 30s backward

export default function OrdersPanel({ data, setSelectedTradeKey }) {
  const rows = useMemo(() => buildRows(data), [data]);
  return (
    <div className="h-full overflow-y-auto text-xs tnum">
      <div className="sticky top-0 grid grid-cols-[80px_60px_60px_1fr_70px] gap-2 px-2 py-1 bg-panel border-b border-border text-[10px] uppercase text-muted tracking-wide">
        <span>POST ts</span>
        <span>side qty</span>
        <span>status</span>
        <span>signal / outcome</span>
        <span className="text-right">matched</span>
      </div>
      {!rows.length && (
        <div className="p-3 text-muted text-[11px]">No relay POSTs yet.</div>
      )}
      {rows.map(r => (
        <button
          key={r.key}
          onClick={() => r.matchedKey != null && setSelectedTradeKey(r.matchedKey)}
          disabled={r.matchedKey == null}
          className={
            'w-full text-left grid grid-cols-[80px_60px_60px_1fr_70px] gap-2 px-2 py-1 ' +
            'border-b border-border/30 hover:bg-accent/[0.04] disabled:cursor-default'
          }
          title={r.matchedKey != null ? 'Click to open tick modal' : 'No matched fill'}
        >
          <span className="text-muted">{fmtTime(r.ts_ns)}</span>
          <span className={r.side === 'long' ? 'text-buy' : r.side === 'short' ? 'text-sell' : 'text-muted'}>
            {r.side ? `${r.side[0].toUpperCase()} ${r.qty}` : '—'}
          </span>
          <StatusChip status={r.status} />
          <span className="truncate" title={r.outcome}>{r.outcome}</span>
          <span className={'text-right ' + (r.matchedKey != null ? 'text-long' : 'text-muted')}>
            {r.matchedKey != null ? '✓' : '—'}
          </span>
        </button>
      ))}
    </div>
  );
}

function StatusChip({ status }) {
  if (status == null) {
    return <span className="text-muted">—</span>;
  }
  const ok = status >= 200 && status < 300;
  return (
    <span className={ok ? 'text-long' : 'text-short'}>{status}</span>
  );
}

function buildRows(data) {
  const audits  = (data?.audit  || []).slice().sort((a, b) => b.ts_ns - a.ts_ns); // newest first
  const brokers = (data?.broker || []).slice().sort((a, b) => a.entry_ts - b.entry_ts);
  const taken   = new Set();
  return audits.map(a => {
    const req = a?.request || {};
    const action = (req.action || '').toLowerCase();
    const side = action.includes('buy')  ? 'long'
              : action.includes('sell') ? 'short'
              : null;
    const qty = Number(req.qty ?? req.quantity ?? 0) || 0;
    const matched = side ? nearestMatch(brokers, taken, a.ts_ns, side, qty) : null;
    if (matched) taken.add(matched);
    const status = a.status;
    const ok = status != null && status >= 200 && status < 300;
    let outcome;
    if (matched)               outcome = `${req.algo_signal_id || '—'} → filled`;
    else if (status == null)   outcome = `${req.algo_signal_id || '—'} (no audit / dryrun)`;
    else if (!ok)              outcome = `${req.algo_signal_id || '—'} → HTTP ${status} ${truncResp(a)}`;
    else                       outcome = `${req.algo_signal_id || '—'} → posted, no broker match`;
    return {
      key:        a.ts_ns,
      ts_ns:      a.ts_ns,
      side, qty,
      status,
      outcome,
      matchedKey: matched ? matched.entry_ts : null,
    };
  });
}

function nearestMatch(list, taken, ts, side, qty) {
  let best = null, bestD = Infinity;
  for (const x of list) {
    if (taken.has(x)) continue;
    if (x.side !== side || x.qty !== qty) continue;
    const delta = x.entry_ts - ts;
    if (delta < -MATCH_BEHIND_NS || delta > MATCH_AHEAD_NS) continue;
    const d = Math.abs(delta);
    if (d < bestD) { bestD = d; best = x; }
  }
  return best;
}

function truncResp(audit) {
  const s = audit?.response;
  if (!s) return '';
  const text = typeof s === 'string' ? s : JSON.stringify(s);
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

function fmtTime(ns) {
  return new Date(ns / 1e6).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
