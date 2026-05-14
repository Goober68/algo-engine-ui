// Singleton-per-coord poller for /broker_truth/status. Components subscribe
// via useBrokerTruthStatus(account, coordUrl) and re-render whenever the
// poller refreshes. One fetch per coord per 30s -- cheaper than per-slot.
//
// Status shape (per account, mirrors coord/broker_truth_poller.py):
//   { account, last_run_ts, age_sec, last_ok, last_error, last_n_trades, in_flight }

import { useEffect, useState } from 'react';

const POLL_MS = 30_000;

// One Poller per distinct coord URL. Refcounted by subscriber count;
// stops polling when no consumers remain so the runners route doesn't
// keep firing requests after the user navigates away.
class Poller {
  constructor(coordUrl) {
    this.coordUrl = coordUrl;
    this.byAccount = new Map();           // account -> latest entry
    this.subs = new Set();                // listener fns -> notified on update
    this.timer = null;
    this.refcount = 0;
    this.lastError = null;
  }
  subscribe(fn) {
    this.subs.add(fn);
    this.refcount += 1;
    if (this.refcount === 1) this.start();
    return () => {
      this.subs.delete(fn);
      this.refcount -= 1;
      if (this.refcount === 0) this.stop();
    };
  }
  start() {
    this.tick();                           // fire immediately so first paint isn't blank
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  async tick() {
    try {
      const r = await fetch(`${this.coordUrl}/broker_truth/status`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      this.byAccount.clear();
      for (const a of (d.accounts || [])) this.byAccount.set(a.account, a);
      this.lastError = null;
    } catch (e) {
      // Coord unreachable / endpoint missing -- surface as a poller error
      // so downstream rendering can show "?" instead of stale ok=true.
      this.lastError = e.message || String(e);
      this.byAccount.clear();
    }
    for (const fn of this.subs) fn();
  }
  get(account) {
    return this.byAccount.get(account) || null;
  }
}

const pollers = new Map();   // coordUrl -> Poller

function pollerFor(coordUrl) {
  let p = pollers.get(coordUrl);
  if (!p) { p = new Poller(coordUrl); pollers.set(coordUrl, p); }
  return p;
}

export function useBrokerTruthStatus(account, coordUrl) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!coordUrl) return;
    const p = pollerFor(coordUrl);
    return p.subscribe(() => force(n => n + 1));
  }, [coordUrl]);
  if (!coordUrl) return { account, status: null, pollerError: 'no coord' };
  const p = pollerFor(coordUrl);
  return { account, status: p.get(account), pollerError: p.lastError };
}
