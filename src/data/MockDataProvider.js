// Data provider — fetches NDJSON folders that look the same whether
// they come from local fixture files (mock mode) or algo-coord
// (real mode). Distinction is BASE URL only.
//
// Mock:  no env var set        → BASE = '/live_2026_05_10' (Vite serves
//                                 fixtures/ as static via publicDir)
// Real:  VITE_ALGO_COORD_URL   → BASE = '<coord>/r/<runner_id>'
//
// Path layout matches in both cases:
//   <BASE>/meta.json             OR  <COORD>/r/<id>/meta
//   <BASE>/slot{N}/bars.jsonl    OR  <COORD>/r/<id>/s/{N}/bars
//   ... etc
//
// Hooks consumed by components: useRunners, useRunner(id),
// useRunnersRegistry, useRunMeta(id), useSlotData(id, n).

import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe, SSE_ENABLED } from './eventBus';
import { activeCoordFor, listCoords } from './coords';

// Runner-data lives on the 'runners' coord scope (typically VPS).
// Read fresh on each request — no module-load capture — so the
// CoordSelector can hot-swap which coord serves runner data without
// a page reload. Other scopes (playground, sweep, historical) read
// from their own scopes via their own data modules.
const FIXTURE_RUN = 'live_2026_05_10';
const REAL = listCoords().length > 0;
const coordUrl = () => activeCoordFor('runners')?.url || '';

const cache = new Map();

async function loadJson(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} ${res.status}`);
  const obj = await res.json();
  cache.set(path, obj);
  return obj;
}

function parseNdjson(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip */ }
  }
  return out;
}

async function loadJsonl(path, force = false) {
  if (!force && cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} ${res.status}`);
  const out = parseNdjson(await res.text());
  cache.set(path, out);
  return out;
}

// Bars carry provenance headers (X-Bars-Source / X-Bars-Archive /
// X-Bars-Counts) the generic loadJsonl cache path can't surface, so
// bars get their own loader returning { bars, meta }. meta.archive
// === 'unavailable' means coord's archive path yielded nothing and
// the chart is live-only (bars.jsonl ~= today) — the UI must show
// that, not silently render a truncated chart (prime directive).
// Cached under a distinct key so it doesn't collide with any generic
// loadJsonl(barsPath) reader.
async function loadBars(path, force = false) {
  const ck = `__bars__${path}`;
  if (!force && cache.has(ck)) return cache.get(ck);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} ${res.status}`);
  const bars = parseNdjson(await res.text());
  const meta = {
    source:  res.headers.get('X-Bars-Source')  || 'unknown',
    archive: res.headers.get('X-Bars-Archive') || 'unknown',
    counts:  res.headers.get('X-Bars-Counts')  || '',
  };
  const tuple = { bars, meta };
  cache.set(ck, tuple);
  return tuple;
}

// ── Path resolution: mock vs real ────────────────────────────────────

function registryUrl() {
  return REAL ? `${coordUrl()}/runners` : '/runners.json';
}
function metaUrl(runnerId) {
  return REAL ? `${coordUrl()}/r/${runnerId}/meta` : `/${FIXTURE_RUN}/meta.json`;
}
function slotFileUrl(runnerId, slotIdx, file) {
  // Mock files end in .jsonl; real files have no extension (NDJSON content-type).
  if (REAL) {
    const trim = file.replace(/\.jsonl$/, '');
    return `${coordUrl()}/r/${runnerId}/s/${slotIdx}/${trim}`;
  }
  return `/${FIXTURE_RUN}/slot${slotIdx}/${file}`;
}

// ── Hooks ────────────────────────────────────────────────────────────

export function useRunnersRegistry() {
  const [reg, setReg] = useState(null);
  useEffect(() => {
    loadJson(registryUrl()).then(setReg).catch(console.error);
  }, []);
  return reg;
}

export function useRunners() {
  const reg = useRunnersRegistry();
  return reg?.runners || null;
}

export function useRunner(id) {
  const runners = useRunners();
  return runners?.find(r => r.id === id) || null;
}

export function useRunMeta(runnerId) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    if (!runnerId) return;
    loadJson(metaUrl(runnerId)).then(setMeta).catch(console.error);
  }, [runnerId]);
  return meta;
}

export function useSlotData(runnerId, slotIdx) {
  const [data, setData] = useState(null);
  const tradesRefetchTimer = useRef(null);

  // Trades are derived server-side by pairing fill events from the
  // decisions log -- so the UI re-fetches /trades whenever a fill
  // SSE arrives. Debounced so a TP+exit pair (~1 ms apart in tick
  // time) collapses into one HTTP roundtrip.
  const refetchTrades = useCallback(() => {
    if (!runnerId || slotIdx == null) return;
    const path = slotFileUrl(runnerId, slotIdx, 'trades.jsonl');
    cache.delete(path);
    loadJsonl(path).then(trades => {
      setData(prev => prev ? { ...prev, trades } : prev);
    }).catch(console.error);
  }, [runnerId, slotIdx]);

  // Initial fetch — full historical via REST. Split into a fast
  // quartet (trades/broker/decisions/audit -- short JSONL tails)
  // and a slow loner (bars -- 24h cold-cache aggregation can take
  // 30s+ on the first load of the day). Render as soon as the
  // quartet lands; bars merge in when ready, so the slot view
  // doesn't sit at "Loading slot N..." for half a minute waiting
  // on the bars endpoint to finish decoding DBN files.
  useEffect(() => {
    if (!runnerId || slotIdx == null) return;
    let cancelled = false;

    const tradesP = slotFileUrl(runnerId, slotIdx, 'trades.jsonl');
    const brokerP = slotFileUrl(runnerId, slotIdx, 'broker_truth.jsonl');
    const decP    = slotFileUrl(runnerId, slotIdx, 'decisions.jsonl');
    const auditP  = slotFileUrl(runnerId, slotIdx, 'audit.jsonl');
    const armsP   = slotFileUrl(runnerId, slotIdx, 'trail_arms.jsonl');
    const barsP   = slotFileUrl(runnerId, slotIdx, 'bars.jsonl');

    // Stale-while-revalidate. Previously every slot/runner switch did
    // setData(null) + a blanket cache.delete + full refetch, which
    // blanked the view and (pre-fast-fail) hung ~21s on bars. Now: if
    // this slot was visited before, render the cached snapshot
    // INSTANTLY, then refetch fresh in the background and swap on
    // arrival. The live SSE stream mutates `data` in place between
    // visits, so the cached snapshot is only a few seconds stale and
    // the background refetch converges it — correctness preserved
    // (per the prime directive: never SILENTLY stale; this is
    // show-then-reconcile within seconds, and bars carry an explicit
    // archive-status banner).
    const c = (p) => cache.get(p);
    const barsTuple = cache.get(`__bars__${barsP}`);
    if (c(tradesP) && c(brokerP) && c(decP)) {
      setData({
        bars: barsTuple?.bars || [],
        barsMeta: barsTuple?.meta || null,
        trades: c(tradesP), broker: c(brokerP), decisions: c(decP),
        audit: c(auditP) || [], trail_arms: c(armsP) || [],
      });
    } else {
      setData(null);   // first visit to this slot — show loading
    }

    // Background refresh (force=true bypasses + refreshes the cache).
    // Quartet and bars resolve independently; each setData preserves
    // the other's slice via prev so a race can't drop data.
    Promise.all([
      loadJsonl(tradesP, true),
      loadJsonl(brokerP, true),
      loadJsonl(decP, true),
      loadJsonl(auditP, true).catch(() => []),   // mock may lack audit
      loadJsonl(armsP, true).catch(() => []),    // emission rolling out
    ]).then(([trades, broker, decisions, audit, trail_arms]) => {
      if (cancelled) return;
      setData(prev => ({
        bars: prev?.bars || [], barsMeta: prev?.barsMeta || null,
        trades, broker, decisions, audit, trail_arms,
      }));
    }).catch(console.error);

    loadBars(barsP, true)
      .then(({ bars, meta }) => {
        if (cancelled) return;
        setData(prev => prev
          ? { ...prev, bars, barsMeta: meta }
          : { bars, barsMeta: meta, trades: [], broker: [], decisions: [], audit: [], trail_arms: [] });
      }).catch(console.error);

    return () => { cancelled = true; };
  }, [runnerId, slotIdx]);

  // Live subscription — append incoming decisions and merge their MA/ATR
  // values into the matching bar (by bar_idx). Earlier this code
  // synthesized a duplicate bar at the decision's ts_ns; that left two
  // bars at the same timestamp in the array and, combined with the
  // chart's `t < lastTime` incremental-skip, caused late decisions to be
  // dropped silently — visible as the MA stair-stepping and early
  // termination bug. Now bar_update events are the single source of bar
  // structure; decisions only contribute the per-slot indicator values.
  // No-op in mock mode (SSE_ENABLED=false).
  const onDecision = useCallback((evt) => {
    const d = evt.data;
    // Fill events trigger a debounced trades-refetch -- coord derives
    // /trades from the same fill stream, so an entry or exit fill is
    // exactly when the trades view changes. 200ms debounce lets the
    // exit-side fill catch up to its entry-side partner.
    if (d && d.type === 'fill') {
      if (tradesRefetchTimer.current) clearTimeout(tradesRefetchTimer.current);
      tradesRefetchTimer.current = setTimeout(refetchTrades, 200);
    }
    if (!d || d.type !== 'decision') return;
    setData(prev => {
      if (!prev) return prev;
      // Skip if we already have this ts_ns (warmup-from-history can
      // re-emit during reconnect; matches the same dedup rule the
      // fixture generator + chart pane both apply).
      const lastDec = prev.decisions[prev.decisions.length - 1];
      if (lastDec && lastDec.ts_ns >= d.ts_ns) return prev;
      const decisions = [...prev.decisions, d];

      // Merge MA/ATR into the matching bar by bar_idx. Bounded lookback
      // avoids walking the whole bars array for every decision — late
      // arrivals past LOOKBACK_BARS indicate data-feed problems, not
      // normal race timing.
      const x = d.xovd || {};
      const newFast = x.fast_ma || 0;
      const newSlow = x.slow_ma || 0;
      const newAtr  = x.atr || 0;
      const LOOKBACK_BARS = 50;
      let bars = prev.bars;
      let matched = false;
      const start = Math.max(0, bars.length - LOOKBACK_BARS);
      for (let i = bars.length - 1; i >= start; i--) {
        if (bars[i].bar_idx === d.bar_idx) {
          bars = bars.slice();
          bars[i] = { ...bars[i],
            fast_ma: newFast, slow_ma: newSlow, atr: newAtr };
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Fallback: decision arrived before any bar_update for its
        // bar_idx (or bars.jsonl is unavailable — dev capture, archived
        // run). Synthesize a bar from the decision. A later bar_update
        // for the same bar_idx will merge real OHLC into it in place.
        const lastBar = bars[bars.length - 1];
        const bar = synthesizeBarFromDecision(d, lastBar);
        if (bar) bars = [...bars, bar];
      }

      return { ...prev, decisions, bars };
    });
  }, []);

  useEffect(() => {
    if (!SSE_ENABLED || !runnerId || slotIdx == null) return;
    return subscribe({
      runnerId, slotIdx, kind: 'decision', callback: onDecision,
    });
  }, [runnerId, slotIdx, onDecision]);

  // Per-second forming-bar updates. Same bar_idx is updated in place
  // (forming bar) until a new bar_idx arrives (bar close + open of
  // next). Chart pane consumes this via a separate useEffect that
  // reads `data.bars[last]` reference identity.
  const onBarUpdate = useCallback((evt) => {
    const b = evt?.bar;
    if (!b || b.bar_idx == null) return;
    setData(prev => {
      if (!prev) return prev;
      const last = prev.bars[prev.bars.length - 1];
      if (last && last.bar_idx === b.bar_idx) {
        // Update in place — preserve any MA/ATR already merged in by a
        // decision event for this bar_idx.
        const merged = { ...last,
          open: b.open, high: b.high, low: b.low,
          close: b.close, volume: b.volume };
        return { ...prev, bars: [...prev.bars.slice(0, -1), merged] };
      }
      // New bar — append with MA/ATR ZERO (not seeded from prior bar).
      // The chart's MA series filters fast_ma > 0, so the line ends at
      // the last bar that actually has a decision-emitted MA. The
      // forming bar's MA isn't defined until the bar closes; per
      // feedback_prime_directive_correctness.md we surface that as a
      // visible gap rather than smoothing over with stale data.
      const seed = { fast_ma: 0, slow_ma: 0, atr: 0 };
      return { ...prev, bars: [...prev.bars, { ...b, ...seed }] };
    });
  }, []);

  useEffect(() => {
    if (!SSE_ENABLED || !runnerId) return;
    return subscribe({ runnerId, kind: 'bar_update', callback: onBarUpdate });
  }, [runnerId, onBarUpdate]);

  // Per-tick updates push the latest bar's close + extend high/low.
  // Throttled to ~4/sec on the coord side so we're not re-rendering
  // the whole bars array storm-style. Tick events are GLOBAL (no
  // runner_id since the broadcaster fans out to all subscribers
  // regardless of which runner they "belong" to).
  const onTick = useCallback((evt) => {
    const tickPx = (evt?.bid + evt?.ask) / 2;
    if (!Number.isFinite(tickPx)) return;
    setData(prev => {
      if (!prev || !prev.bars.length) return prev;
      const last = prev.bars[prev.bars.length - 1];
      const merged = {
        ...last,
        high:  Math.max(last.high, tickPx),
        low:   Math.min(last.low, tickPx),
        close: tickPx,
      };
      return { ...prev, bars: [...prev.bars.slice(0, -1), merged] };
    });
  }, []);

  useEffect(() => {
    if (!SSE_ENABLED || !runnerId) return;
    // Use the existing runner-scoped EventSource. Tick events fire to
    // all subscribers regardless of runner filter (no runner_id in
    // payload), so passing runnerId here just routes the listener
    // through the same connection — no extra SSE socket.
    return subscribe({ runnerId, kind: 'tick', callback: onTick });
  }, [runnerId, onTick]);

  // Live relay-audit appends: each new POST attempt arrives as a
  // relay_audit event, append to data.audit. Drives the Orders tab.
  const onAudit = useCallback((evt) => {
    const rec = evt?.data;
    if (!rec || rec.ts_ns == null) return;
    setData(prev => {
      if (!prev) return prev;
      const audit = prev.audit || [];
      // Skip duplicate by ts_ns (defensive — runner shouldn't double-write).
      if (audit.length && audit[audit.length - 1].ts_ns === rec.ts_ns) return prev;
      return { ...prev, audit: [...audit, rec] };
    });
  }, []);

  useEffect(() => {
    if (!SSE_ENABLED || !runnerId || slotIdx == null) return;
    return subscribe({ runnerId, slotIdx, kind: 'relay_audit', callback: onAudit });
  }, [runnerId, slotIdx, onAudit]);

  // Reconcile events: when the broker-truth poller refreshes the CSV
  // for our slot's account, re-fetch broker_truth + replace the array.
  // Cache busted so the new file content is read.
  const onReconcile = useCallback((evt) => {
    if (!evt?.ok) return;
    const path = slotFileUrl(runnerId, slotIdx, 'broker_truth.jsonl');
    cache.delete(path);
    loadJsonl(path).then(broker => {
      setData(prev => prev ? { ...prev, broker } : prev);
    }).catch(console.error);
  }, [runnerId, slotIdx]);

  useEffect(() => {
    if (!SSE_ENABLED || !runnerId || slotIdx == null) return;
    return subscribe({
      runnerId, slotIdx, kind: 'reconcile', callback: onReconcile,
    });
  }, [runnerId, slotIdx, onReconcile]);

  return data;
}

// Mirror of coord/jsonl.py:synthesize_bars — same H/L fakery so live
// bars match the historical ones the REST endpoint produced. Replace
// once runner.exe emits real bar events.
function synthesizeBarFromDecision(d, lastBar) {
  const x = d.xovd || {};
  const c = x.close;
  if (c == null) return null;
  const TICK = 0.25;
  const pc = lastBar ? lastBar.close : c;
  const rng = Math.abs(c - pc);
  const half = Math.max(rng / 2, TICK);
  const o = pc;
  const h = Math.round((Math.max(o, c) + half * 0.4) / TICK) * TICK;
  const l = Math.round((Math.min(o, c) - half * 0.4) / TICK) * TICK;
  return {
    ts_ns: d.ts_ns,
    bar_idx: d.bar_idx,
    open:  Math.round(o * 100) / 100,
    high:  Math.round(h * 100) / 100,
    low:   Math.round(l * 100) / 100,
    close: Math.round(c * 100) / 100,
    volume: 0,
    fast_ma: x.fast_ma || 0,
    slow_ma: x.slow_ma || 0,
    atr:     x.atr || 0,
  };
}

// Runner stdout/stderr tail. Initial-fetch via REST + live-append via
// SSE. Caps retained lines to keep DOM sane.
export function useRunnerLogs(runnerId, kind, maxLines = 500) {
  const [lines, setLines] = useState([]);

  // Initial seed
  useEffect(() => {
    if (!runnerId || !kind) return;
    setLines([]);
    if (!REAL) return;
    fetch(`${coordUrl()}/r/${runnerId}/logs/${kind}/initial?lines=200`)
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (j?.lines) setLines(j.lines);
      })
      .catch(console.error);
  }, [runnerId, kind]);

  // Live append from SSE
  const onLine = useCallback((evt) => {
    if (!evt?.line) return;
    setLines(prev => {
      const next = prev.length >= maxLines
        ? [...prev.slice(prev.length - maxLines + 1), evt.line]
        : [...prev, evt.line];
      return next;
    });
  }, [maxLines]);

  useEffect(() => {
    if (!SSE_ENABLED || !runnerId || !kind) return;
    const sseKind = kind === 'stdout' ? 'log_stdout' : 'log_stderr';
    return subscribe({ runnerId, kind: sseKind, callback: onLine });
  }, [runnerId, kind, onLine]);

  return lines;
}

// Per-slot relay audit feed (entry POSTs). Live-only — coord doesn't
// have an initial-tail endpoint for audits yet (could add the same
// pattern; deferred since live-tail is what matters operationally).
export function useRelayAudit(runnerId, slotIdx, maxRecords = 200) {
  const [records, setRecords] = useState([]);
  useEffect(() => { setRecords([]); }, [runnerId, slotIdx]);
  const onAudit = useCallback((evt) => {
    if (!evt?.data) return;
    setRecords(prev => {
      const next = prev.length >= maxRecords
        ? [...prev.slice(prev.length - maxRecords + 1), evt.data]
        : [...prev, evt.data];
      return next;
    });
  }, [maxRecords]);
  useEffect(() => {
    if (!SSE_ENABLED || !runnerId || slotIdx == null) return;
    return subscribe({ runnerId, slotIdx, kind: 'relay_audit', callback: onAudit });
  }, [runnerId, slotIdx, onAudit]);
  return records;
}

// Live-tick parser. Runner.exe emits a periodic stdout line:
//   [status] ticks=22540000 bars=821 reconnects=0 (last bid=29278.00 ask=29278.75)
// We piggyback on the log_stdout SSE stream rather than building a
// new tick-stream endpoint — same data, free.
const STATUS_RE = /\[status\]\s+ticks=(\d+)\s+bars=(\d+)\s+reconnects=(\d+)\s+\(last bid=([\d.]+) ask=([\d.]+)\)/;

export function useLiveTick(runnerId) {
  const [tick, setTick] = useState(null);
  const onLine = useCallback((evt) => {
    if (!evt?.line) return;
    const m = STATUS_RE.exec(evt.line);
    if (!m) return;
    setTick({
      ts:        Date.now(),
      ticks:     parseInt(m[1], 10),
      bars:      parseInt(m[2], 10),
      reconnects:parseInt(m[3], 10),
      bid:       parseFloat(m[4]),
      ask:       parseFloat(m[5]),
    });
  }, []);
  useEffect(() => {
    if (!SSE_ENABLED || !runnerId) return;
    return subscribe({ runnerId, kind: 'log_stdout', callback: onLine });
  }, [runnerId, onLine]);
  return tick;
}

// Diagnostic export so the UI can show "mock" or "coord" mode.
export const DATA_MODE = REAL ? 'coord' : 'mock';
// Legacy single-coord export. New code should use activeCoord() from
// './coords' so it stays in sync when the user switches coords.
export const DATA_SOURCE_URL = REAL ? coordUrl() : '/fixtures';
