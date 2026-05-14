// Log-style view of every relay-audit POST for a slot. Reads like a
// tail -- one line per POST, ts + status + JSON content (truncated
// with overflow ellipsis). Click a line to open its matched tick
// modal (when a broker fill paired); orphan POSTs (cap-suppressed,
// HTTP errors, missed fills) stay clickable but have no modal target,
// so they just show their content inline + the matched-fill column
// reads em-dash.
//
// Mirrors stdout/stderr panes' visual density on purpose -- this is
// the third member of the bottom-drawer trio.

import { useEffect, useMemo, useRef, useState } from 'react';
import { PaneHeader } from './LogsDrawer';
import { redactSecrets } from '../../data/redact';

const MATCH_AHEAD_NS  = 5 * 60 * 1_000_000_000;   // 5 min forward
const MATCH_BEHIND_NS = 30 * 1_000_000_000;       // 30s backward

export default function OrdersPanel({ data, setSelectedTradeKey }) {
  const rows = useMemo(() => buildRows(data), [data]);
  const ref = useRef(null);
  const [tail, setTail] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !tail) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, tail]);
  return (
    <>
      <PaneHeader label="relay audit" tail={tail} setTail={setTail} />
      <div ref={ref}
           className="flex-1 overflow-y-auto overflow-x-hidden p-2 text-[11px] font-mono text-muted leading-tight">
        {!rows.length && (
          <span className="italic text-muted">no relay POSTs yet</span>
        )}
        {rows.map(r => (
          <button
            key={r.key}
            onClick={() => r.matchedKey != null && setSelectedTradeKey(r.matchedKey)}
            disabled={r.matchedKey == null}
            title={r.full}
            className={
              'flex items-baseline gap-2 w-full text-left ' +
              'hover:bg-accent/[0.04] disabled:cursor-default'
            }
          >
            <span className="text-muted shrink-0">{fmtTime(r.ts_ns)}</span>
            <StatusChip status={r.status} />
            <span className={'truncate flex-1 ' + r.cls}>{r.line}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function StatusChip({ status }) {
  if (status == null) {
    return <span className="text-muted shrink-0 w-[28px]">---</span>;
  }
  const ok = status >= 200 && status < 300;
  return (
    <span className={'shrink-0 w-[28px] tnum ' + (ok ? 'text-long' : 'text-short')}>
      {status}
    </span>
  );
}

function buildRows(data) {
  // Oldest first so the panel reads top-to-bottom in time order --
  // matches stdout/stderr conventions (newest at the bottom). TAIL
  // toggle then auto-scrolls to bottom = following live data.
  const audits  = (data?.audit  || []).slice().sort((a, b) => a.ts_ns - b.ts_ns);
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
    // One-liner: stringify the request body so the operator can read
    // signal_id / action / price / brackets at a glance. Long; the
    // row's `truncate` + tooltip handle overflow.
    const reqStr = req && Object.keys(req).length
      ? JSON.stringify(redactSecrets(req))
      : '(no request body)';
    let suffix = '';
    if (matched)               suffix = ' → filled';
    else if (status == null)   suffix = '';
    else if (!ok)              suffix = ` → ${truncResp(a)}`;
    else                       suffix = ' → posted, no fill';
    const line = reqStr + suffix;
    // Color: red for HTTP error, green for matched-fill, default
    // muted for posted-but-not-yet-filled / dryrun. Keeps the eye
    // drawn to anomalies the way stderr's red lines do.
    const cls = !ok && status != null ? 'text-short'
              : matched               ? 'text-long/80'
              : '';
    return {
      key:        a.ts_ns,
      ts_ns:      a.ts_ns,
      status,
      line,
      cls,
      full:       JSON.stringify(redactSecrets({ request: req, response: a.response, status }), null, 2),
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
  if (!s) return `HTTP ${audit?.status}`;
  const text = typeof s === 'string' ? s : JSON.stringify(s);
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

function fmtTime(ns) {
  return new Date(ns / 1e6).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
