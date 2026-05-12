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

import { useCallback, useEffect, useState } from 'react';
import { subscribe, SSE_ENABLED } from './eventBus';

const COORD = import.meta.env.VITE_ALGO_COORD_URL?.replace(/\/+$/, '') || '';
const FIXTURE_RUN = 'live_2026_05_10';
const REAL = COORD.length > 0;

const cache = new Map();

async function loadJson(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} ${res.status}`);
  const obj = await res.json();
  cache.set(path, obj);
  return obj;
}

async function loadJsonl(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} ${res.status}`);
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip */ }
  }
  cache.set(path, out);
  return out;
}

// ── Path resolution: mock vs real ────────────────────────────────────

function registryUrl() {
  return REAL ? `${COORD}/runners` : '/runners.json';
}
function metaUrl(runnerId) {
  return REAL ? `${COORD}/r/${runnerId}/meta` : `/${FIXTURE_RUN}/meta.json`;
}
function slotFileUrl(runnerId, slotIdx, file) {
  // Mock files end in .jsonl; real files have no extension (NDJSON content-type).
  if (REAL) {
    const trim = file.replace(/\.jsonl$/, '');
    return `${COORD}/r/${runnerId}/s/${slotIdx}/${trim}`;
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

  // Initial fetch — full historical via REST.
  useEffect(() => {
    if (!runnerId || slotIdx == null) return;
    let cancelled = false;
    setData(null);   // reset on slot/runner change
    // Bust cache so route changes get fresh data when revisiting a slot
    // that was streaming live updates.
    [`bars.jsonl`, `trades.jsonl`, `broker_truth.jsonl`, `decisions.jsonl`, `audit.jsonl`].forEach(f => {
      cache.delete(slotFileUrl(runnerId, slotIdx, f));
    });
    Promise.all([
      loadJsonl(slotFileUrl(runnerId, slotIdx, 'bars.jsonl')),
      loadJsonl(slotFileUrl(runnerId, slotIdx, 'trades.jsonl')),
      loadJsonl(slotFileUrl(runnerId, slotIdx, 'broker_truth.jsonl')),
      loadJsonl(slotFileUrl(runnerId, slotIdx, 'decisions.jsonl')),
      loadJsonl(slotFileUrl(runnerId, slotIdx, 'audit.jsonl'))
        .catch(() => []),    // mock fixtures may not have audit
    ]).then(([bars, trades, broker, decisions, audit]) => {
      if (cancelled) return;
      setData({ bars, trades, broker, decisions, audit });
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [runnerId, slotIdx]);

  // Live subscription — append incoming decisions (and synthesize a
  // bar from each, since the runner emits one decision per bar close).
  // No-op in mock mode (SSE_ENABLED=false). Updates the same `data`
  // object so chart / trade table / strategy panel all re-render.
  const onDecision = useCallback((evt) => {
    const d = evt.data;
    if (!d || d.type !== 'decision') return;
    setData(prev => {
      if (!prev) return prev;
      // Skip if we already have this ts_ns (warmup-from-history can
      // re-emit during reconnect; matches the same dedup rule the
      // fixture generator + chart pane both apply).
      const lastDec = prev.decisions[prev.decisions.length - 1];
      if (lastDec && lastDec.ts_ns >= d.ts_ns) return prev;
      const decisions = [...prev.decisions, d];
      const lastBar = prev.bars[prev.bars.length - 1];
      const bar = synthesizeBarFromDecision(d, lastBar);
      const bars = bar ? [...prev.bars, bar] : prev.bars;
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
        // Update in place — preserve MA/ATR from the existing entry
        // (those come from decision events, not bars.jsonl).
        const merged = { ...last,
          open: b.open, high: b.high, low: b.low,
          close: b.close, volume: b.volume };
        return { ...prev, bars: [...prev.bars.slice(0, -1), merged] };
      }
      // New bar — append. MA/ATR start at the prior bar's values
      // until the next decision event arrives with fresh ones.
      const seed = last
        ? { fast_ma: last.fast_ma, slow_ma: last.slow_ma, atr: last.atr }
        : { fast_ma: 0, slow_ma: 0, atr: 0 };
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
    fetch(`${COORD}/r/${runnerId}/logs/${kind}/initial?lines=200`)
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
export const DATA_SOURCE_URL = REAL ? COORD : '/fixtures';
