// Shared EventSource manager. One connection per runner_id (lazy
// opened on first subscriber, closed when refcount hits zero).
// Components register interest via subscribe(runnerId, slotIdx, kind,
// callback). Only fires the callback for matching events.
//
// In mock mode (no VITE_ALGO_COORD_URL) this is a no-op: events never
// arrive, so subscribers just hold a dead callback.

import { useEffect } from 'react';

const COORD = import.meta.env.VITE_ALGO_COORD_URL?.replace(/\/+$/, '') || '';
const REAL = COORD.length > 0;

// runnerId -> { es: EventSource, refcount, subscribers: Set }
const sources = new Map();

function openSource(runnerId) {
  if (!REAL) return null;
  const url = `${COORD}/stream?runners=${encodeURIComponent(runnerId)}`;
  const es = new EventSource(url);
  const subscribers = new Set();
  const entry = { es, refcount: 0, subscribers };

  const dispatch = (kind, raw) => {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    // hello/ping events don't carry runner_id/slot_idx
    for (const sub of subscribers) {
      if (sub.kind && sub.kind !== kind) continue;
      if (sub.runnerId && evt.runner_id && sub.runnerId !== evt.runner_id) continue;
      if (sub.slotIdx != null && evt.slot_idx != null && sub.slotIdx !== evt.slot_idx) continue;
      try { sub.cb(evt); } catch (e) { console.error('[eventBus] subscriber threw', e); }
    }
  };

  // Named events from algo-coord:
  es.addEventListener('hello',        e => dispatch('hello', e.data));
  es.addEventListener('ping',         e => dispatch('ping', e.data));
  es.addEventListener('decision',     e => dispatch('decision', e.data));
  es.addEventListener('bar_update',   e => dispatch('bar_update', e.data));
  es.addEventListener('tick',         e => dispatch('tick', e.data));
  es.addEventListener('relay_audit',  e => dispatch('relay_audit', e.data));
  es.addEventListener('log_stdout',   e => dispatch('log_stdout', e.data));
  es.addEventListener('log_stderr',   e => dispatch('log_stderr', e.data));
  es.addEventListener('reconcile',    e => dispatch('reconcile', e.data));
  es.addEventListener('tailer_error', e => dispatch('tailer_error', e.data));
  es.onerror = () => { /* EventSource auto-reconnects */ };

  return entry;
}

export function subscribe({ runnerId, slotIdx = null, kind = null, callback }) {
  if (!REAL) return () => {};
  let entry = sources.get(runnerId);
  if (!entry) {
    entry = openSource(runnerId);
    sources.set(runnerId, entry);
  }
  if (!entry) return () => {};
  const sub = { runnerId, slotIdx, kind, cb: callback };
  entry.subscribers.add(sub);
  entry.refcount += 1;
  return () => {
    entry.subscribers.delete(sub);
    entry.refcount -= 1;
    if (entry.refcount <= 0) {
      entry.es.close();
      sources.delete(runnerId);
    }
  };
}

// React hook helper — fires callback for matching events, cleans up on
// unmount. Stable callback recommended (wrap in useCallback if it
// closes over changing state).
export function useEventSubscription({ runnerId, slotIdx, kind, callback }) {
  useEffect(() => {
    if (!runnerId) return;
    return subscribe({ runnerId, slotIdx, kind, callback });
  }, [runnerId, slotIdx, kind, callback]);
}

export const SSE_ENABLED = REAL;
