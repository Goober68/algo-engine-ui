// Trade table — algo-primary view with broker truth + webhook status
// stitched on. Columns: time, dir, qty, entry, exit, hold, algo $,
// broker $, Δ, http, why.
//
// Row sources:
//   - algo (data.trades)   — sim fills from the runner. Always shown.
//   - broker (data.broker) — real fills. Attached to matching algo
//                              rows by side+qty within MATCH_WINDOW.
//   - orphan broker        — broker trades with no algo match get
//                              their own row (manual fill, restart-
//                              orphan, OR a match-window miss).
//
// Two optional overlays (toggles):
//   + orders — relay POSTs that didn't reach broker. Useful when
//              the algo "thinks" it traded but the wire failed.
//   + blocks — gate-blocked decisions (no POST attempted).
//
// Default sort = chronological asc; auto-scroll to bottom on new rows
// unless the user scrolled away.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const FILTERS = [
  ['all',     'All'],
  ['long',    'Long'],
  ['short',   'Short'],
  ['win',     'Win'],
  ['loss',    'Loss'],
  ['tp',      'TP'],
  ['sl',      'SL'],
  ['trail',   'TRAIL'],
];

// POST→fill matching window. A relay POST and a broker fill belong
// together if (a) same side+qty, (b) the broker entry is within
// [POST_ts - 5s, POST_ts + MATCH_AHEAD] — i.e. fills happen AFTER
// the POST, not before. GTD limit orders can sit pending for 3 min+
// (bar period) so the forward window has to span that, or we
// misclassify long-pending fills as errored orphans.
const MATCH_BEHIND_NS =        5 * 1_000_000_000;   // tolerate small clock skew backward
const MATCH_AHEAD_NS  = 5 * 60 * 1_000_000_000;     // 5 min forward — covers a 3-min GTD + buffer

export default function TradeTable({ data, filter, setFilter, selectedTradeKey, setSelectedTradeKey }) {
  const [sort, setSort] = useState({ key: 'ts', dir: 'asc' });
  const [showOrders, setShowOrders] = useState(true);
  const [showBlocks, setShowBlocks] = useState(false);

  const tradeRows = useMemo(() => buildTradeRows(data, filter), [data, filter]);
  const orderRows = useMemo(() => buildUnfilledOrderRows(data),  [data]);
  const blockRows = useMemo(() => buildBlockRows(data),          [data]);

  const merged = useMemo(() => {
    const arr = [...tradeRows];
    if (showOrders) arr.push(...orderRows);
    if (showBlocks) arr.push(...blockRows);
    return sortRows(arr, sort);
  }, [tradeRows, orderRows, blockRows, showOrders, showBlocks, sort]);

  // Keep the table pinned to the latest row (visually = bottom when
  // sorted asc, top when desc) — but ONLY when the user is already
  // at that edge. A small tolerance covers the row-height jitter when
  // a new row appends.
  const scrollRef = useRef(null);
  const stickRef  = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (sort.dir === 'asc') {
      stickRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 8;
    } else {
      stickRef.current = el.scrollTop < 8;
    }
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = sort.dir === 'asc' ? el.scrollHeight : 0;
  }, [merged.length, sort.dir]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-1 px-2 py-2 border-b border-border">
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-2 py-0.5 text-[11px] rounded ${
              filter === k
                ? 'bg-accent text-bg'
                : 'bg-bg border border-border text-muted hover:text-text'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="text-muted mx-1">·</span>
        <Toggle on={showOrders} setOn={setShowOrders} count={orderRows.length}
                label="orders" title="Show relay POSTs that didn't become broker trades (cap-suppressed, errored, or GTD expired)" />
        <Toggle on={showBlocks} setOn={setShowBlocks} count={blockRows.length}
                label="blocks" title="Show decisions blocked by infra/session/algo/trading gates (no POST attempted)" />
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        <table className="w-full text-xs tnum">
          <thead className="sticky top-0 bg-panel text-muted">
            <tr>
              <Th label="time"   k="ts"         sort={sort} setSort={setSort} />
              <Th label="dir"    k="side"       sort={sort} setSort={setSort} />
              <Th label="qty"    k="qty"        sort={sort} setSort={setSort} />
              <Th label="entry"  k="entry_px"   sort={sort} setSort={setSort} />
              <Th label="exit"   k="exit_px"    sort={sort} setSort={setSort} />
              <Th label="hold"   k="hold_min"   sort={sort} setSort={setSort} />
              <Th label="algo $"   k="algo_pnl"   sort={sort} setSort={setSort} />
              <Th label="broker $" k="broker_pnl" sort={sort} setSort={setSort} />
              <Th label="Δ"      k="delta"      sort={sort} setSort={setSort} />
              <Th label="http"   k="status"     sort={sort} setSort={setSort} />
              <Th label="why"    k="reason"     sort={sort} setSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {merged.map((r, i) => <Row key={`${r.kind}:${r.ts}:${i}`} row={r}
                                       selected={selectedTradeKey === r.ts}
                                       onClick={() => setSelectedTradeKey(r.ts)} />)}
            {merged.length === 0 && (
              <tr><td colSpan={11} className="text-center text-muted py-4">no rows</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Toggle({ on, setOn, count, label, title }) {
  return (
    <button
      onClick={() => setOn(v => !v)}
      title={title}
      className={`px-2 py-0.5 text-[11px] rounded inline-flex items-center gap-1 ${
        on
          ? 'bg-accent/30 text-text border border-accent'
          : 'bg-bg border border-border text-muted hover:text-text'
      }`}
    >
      <span>{on ? '✓' : '+'}</span>
      <span>{label}</span>
      <span className="opacity-60">{count}</span>
    </button>
  );
}

function Row({ row, selected, onClick }) {
  // Dim only "failure" rows so the table draws the eye toward things
  // that succeeded. Blocked decisions and POSTs that errored or were
  // cap-suppressed fade out; a 2xx order that just hasn't matched a
  // broker fill yet stays full opacity (it's a live order, not a miss).
  const isFailOrder = row.kind === 'order' && (row.status === 0 || row.status >= 400);
  const dim = row.kind === 'block' || isFailOrder;
  return (
    <tr onClick={onClick}
        className={`cursor-pointer hover:bg-bg ${selected ? 'bg-accent/20' : ''} ${dim ? 'opacity-55' : ''}`}>
      <td className="px-2 py-0.5 text-right text-muted">{fmtT(row.ts)}</td>
      <td className={`px-2 py-0.5 text-right ${
        row.side === 'long'  ? 'text-buy'
      : row.side === 'short' ? 'text-sell'
      : 'text-muted'}`}>{row.side || '—'}</td>
      <td className="px-2 py-0.5 text-right">{row.qty || '—'}</td>
      <td className="px-2 py-0.5 text-right">{row.entry_px?.toFixed(2) ?? '—'}</td>
      <td className="px-2 py-0.5 text-right">{row.exit_px?.toFixed(2) ?? '—'}</td>
      <td className="px-2 py-0.5 text-right text-muted">{fmtHold(row.hold_min)}</td>
      <td className={`px-2 py-0.5 text-right ${pnlCls(row.algo_pnl)}`}>{fmtD(row.algo_pnl)}</td>
      <td className={`px-2 py-0.5 text-right ${pnlCls(row.broker_pnl)}`}>{fmtD(row.broker_pnl)}</td>
      <td className={`px-2 py-0.5 text-right ${deltaCls(row.delta)}`}>{fmtD(row.delta)}</td>
      <td className={`px-2 py-0.5 text-right text-[10px] ${statusCls(row.status)}`}>{fmtStatus(row.status)}</td>
      <td className={`px-2 py-0.5 text-right ${reasonCls(row.reason)}`}>{shortReason(row.reason)}</td>
    </tr>
  );
}

// ── Row builders ────────────────────────────────────────────────────

function buildTradeRows(data, filter) {
  const algos   = (data.trades || []).slice().sort((a, b) => a.entry_ts - b.entry_ts);
  const brokers = (data.broker || []).slice().sort((a, b) => a.entry_ts - b.entry_ts);
  const audits  = (data.audit  || []).slice().sort((a, b) => a.ts_ns    - b.ts_ns);

  const brokerTaken = new Set();
  const auditTaken  = new Set();
  const rows = [];

  for (const a of algos) {
    const broker = nearestMatch(brokers, brokerTaken, a.entry_ts, a.side, a.qty);
    if (broker) brokerTaken.add(broker);
    const audit  = nearestAudit(audits,  auditTaken,  a.entry_ts, a.side, a.qty);
    if (audit)  auditTaken.add(audit);
    rows.push({
      kind:       'trade',
      ts:         a.entry_ts,
      side:       a.side,
      qty:        a.qty,
      entry_px:   a.entry_px,
      exit_px:    a.exit_px,
      exit_ts:    a.exit_ts,
      hold_min:   a.exit_ts ? (a.exit_ts - a.entry_ts) / 6e10 : 0,
      algo_pnl:   a.pnl,
      broker_pnl: broker?.pnl ?? null,
      // Δ = broker - algo. When the broker has no match (cap-suppressed
      // POST, HTTP err, or just plain didn't fill), the algo *thinks*
      // it made a.pnl that wasn't realized — Δ = -a.pnl, which lights
      // up red and makes the missed-fill cost obvious.
      delta:      computeDelta(a.pnl, broker?.pnl),
      status:     audit?.status ?? null,
      reason:     a.reason || inferReason(a),
    });
  }

  // Orphan broker trades — broker filled something with no matching
  // algo (sim) trade. Two cases:
  //   - algo_id set: the relay knows it was algo-placed, but the
  //     runner's sim didn't emit a matching trade (likely the
  //     runner doesn't write trades.jsonl in this build, OR a
  //     restart dropped the sim row). Render as a normal row.
  //   - algo_id empty: truly manual entry. Flag it.
  for (const b of brokers) {
    if (brokerTaken.has(b)) continue;
    const isManual = !b.algo_id || b.algo_id === '';
    rows.push({
      kind:       'broker_only',
      ts:         b.entry_ts,
      side:       b.side,
      qty:        b.qty,
      entry_px:   b.entry_px,
      exit_px:    b.exit_px,
      exit_ts:    b.exit_ts,
      hold_min:   b.exit_ts ? (b.exit_ts - b.entry_ts) / 6e10 : 0,
      algo_pnl:   null,
      broker_pnl: b.pnl,
      // Manual / orphan broker: algo contributed 0, broker contributed
      // b.pnl. Δ = broker - 0 = broker.pnl — green for a winning manual
      // trade, red for a losing one. Tells you whether the un-algo'd
      // activity is helping or hurting at a glance.
      delta:      computeDelta(null, b.pnl),
      status:     null,
      reason:     isManual ? 'manual' : '',
    });
  }

  if (filter === 'all') return rows;
  return rows.filter(r => {
    if (filter === 'long' || filter === 'short') return r.side === filter;
    const p = r.broker_pnl ?? r.algo_pnl;
    if (filter === 'win')  return p > 0;
    if (filter === 'loss') return p <= 0;
    return r.reason === filter;
  });
}

// Find the nearest unused broker match for an algo trade. Symmetric
// window (algo entry could be slightly before or after broker fill).
function nearestMatch(list, taken, ts, side, qty) {
  let best = null, bestD = Infinity;
  for (const x of list) {
    if (taken.has(x)) continue;
    if (x.side !== side || x.qty !== qty) continue;
    const d = Math.abs(x.entry_ts - ts);
    if (d > MATCH_AHEAD_NS) continue;
    if (d < bestD) { bestD = d; best = x; }
  }
  return best;
}

// Find the audit POST that caused a given broker/algo entry. POST
// precedes the fill by up to MATCH_AHEAD_NS (a few seconds for market
// hits, several minutes for resting GTD limits).
function nearestAudit(audits, taken, ts, side, qty) {
  let best = null, bestD = Infinity;
  for (const a of audits) {
    if (taken.has(a)) continue;
    const req = a.request || {};
    const action = (req.action || '').toLowerCase();
    const aSide  = action.includes('buy') ? 'long' : action.includes('sell') ? 'short' : null;
    if (aSide !== side) continue;
    if (Number(req.quantity) !== qty) continue;
    const delta = ts - a.ts_ns;   // positive = POST came before fill
    if (delta < -MATCH_BEHIND_NS || delta > MATCH_AHEAD_NS) continue;
    if (Math.abs(delta) < bestD) { bestD = Math.abs(delta); best = a; }
  }
  return best;
}

function buildUnfilledOrderRows(data) {
  // An audit POST "became a trade" if a broker fill of matching side+qty
  // showed up within [POST_ts - 5s, POST_ts + 5min]. Anything else =
  // genuinely unfilled (or fill came in outside the window — bump
  // MATCH_AHEAD_NS if you start seeing real fills appear as ERR).
  const broker = data.broker || [];
  const out = [];
  for (const a of (data.audit || [])) {
    const req = a.request || {};
    const action = (req.action || '').toLowerCase();
    if (!action) continue;
    const side = action.includes('buy') ? 'long'
              : action.includes('sell') ? 'short' : null;
    if (!side) continue;
    const qty = Number(req.quantity);
    if (!qty) continue;
    const matched = broker.some(b => {
      if (b.side !== side || b.qty !== qty) return false;
      const delta = b.entry_ts - a.ts_ns;
      return delta >= -MATCH_BEHIND_NS && delta <= MATCH_AHEAD_NS;
    });
    if (matched) continue;
    out.push({
      kind:       'order',
      ts:         a.ts_ns,
      side, qty,
      entry_px:   req.price,
      exit_px:    null,
      hold_min:   0,
      algo_pnl:   null,
      broker_pnl: null,
      delta:      null,
      status:     a.status,
      reason:     a.status === 0 ? 'cap'
              : a.status >= 200 && a.status < 300 ? 'no fill'
              : a.status >= 400 ? `HTTP ${a.status}` : '?',
    });
  }
  return out;
}

function buildBlockRows(data) {
  const out = [];
  for (const d of data.decisions || []) {
    if (d.is_warmup) continue;
    if (!d.blocked_layer || d.blocked_layer === 'none') continue;
    if (d.order_placed >= 0) continue;
    out.push({
      kind:       'block',
      ts:         d.ts_ns,
      side:       null,
      qty:        null,
      entry_px:   null,
      exit_px:    null,
      hold_min:   0,
      algo_pnl:   null,
      broker_pnl: null,
      delta:      null,
      status:     null,
      reason:     `⊘ ${d.blocked_layer}/${d[`${d.blocked_layer}_gate`] || '—'}`,
    });
  }
  return out;
}

function sortRows(rows, sort) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key]; const bv = b[sort.key];
    if (av == null && bv == null) return 0;
    if (av == null) return -dir;
    if (bv == null) return dir;
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

// Δ = broker - algo, with a missing side treated as 0 so a one-sided
// trade still surfaces its full magnitude. Null only when BOTH sides
// are missing realized PnL (e.g. an in-flight algo position).
function computeDelta(algoPnl, brokerPnl) {
  const a = algoPnl;
  const b = brokerPnl;
  if (a == null && b == null) return null;
  return (b ?? 0) - (a ?? 0);
}

function inferReason(t) {
  if (t.pnl == null) return '';
  if (t.pnl >  30) return 'tp';
  if (t.pnl < -30) return 'sl';
  return 'trail';
}

// ── Helpers ─────────────────────────────────────────────────────────

function Th({ label, k, sort, setSort }) {
  const active = sort.key === k;
  return (
    <th
      className={`px-2 py-0.5 text-right font-normal cursor-pointer hover:text-text ${active ? 'text-text' : ''}`}
      onClick={() => setSort(prev => ({
        key: k,
        dir: prev.key === k && prev.dir === 'desc' ? 'asc' : 'desc',
      }))}
    >
      {label}{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
}

function fmtT(ns) {
  return new Date(ns / 1e6).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
// "1.4m" is awkward to scan. "1:24" reads naturally. For <60s show "42s".
function fmtHold(min) {
  if (!min || min <= 0) return '—';
  const totalSec = Math.round(min * 60);
  if (totalSec < 60) return totalSec + 's';
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function fmtD(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}
function fmtStatus(s) {
  if (s == null) return '';
  if (s === 0) return 'cap';
  return String(s);
}
function pnlCls(v) {
  if (v == null) return '';
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : '';
}
// Δ is "broker - sim". Any positive divergence is good (real beat sim),
// any negative is bad — color them like PnL so the eye scans the column
// for trouble the same way it scans the PnL column.
function deltaCls(v) {
  if (v == null) return '';
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : '';
}
function statusCls(s) {
  if (s == null) return '';
  if (s === 0) return 'text-trail';
  if (s >= 200 && s < 300) return 'text-long';   // green — successful POST
  if (s >= 400) return 'text-short';
  return '';
}
// Map the runner's FillReason strings (and a few derived ones from the
// order/block overlays) to terse 2-3 char tokens + colors. The runner
// emits e.g. "trail_exit"; the operator wants "TS".
function shortReason(r) {
  if (!r) return '';
  return REASON_SHORT[r] || r;
}
const REASON_SHORT = {
  tp_hit:        'TP',
  sl_hit:        'SL',
  trail_exit:    'TS',
  max_bars_exit: 'MBX',
  session_exit:  'EOS',
  live_broker:   'BRK',
  market_cross:  'MX',
  open:          'OPEN',
  manual:        'manual',
  'no fill':     'no fill',
  cap:           'cap',
};
function reasonCls(r) {
  if (r === 'tp_hit')        return 'text-tp';
  if (r === 'sl_hit')        return 'text-sl';
  if (r === 'trail_exit')    return 'text-trail';
  if (r === 'max_bars_exit') return 'text-muted';
  if (r === 'session_exit')  return 'text-muted';
  if (r === 'live_broker')   return 'text-muted';
  if (r === 'market_cross')  return 'text-muted';
  if (r === 'open')          return 'text-accent';
  if (r === 'manual')        return 'text-muted italic';
  if (r === 'cap')           return 'text-trail';
  if (r === 'no fill')       return 'text-muted';
  if (r && r.startsWith('HTTP')) return 'text-short';
  if (r && r.startsWith('⊘'))    return 'text-short';
  return '';
}
