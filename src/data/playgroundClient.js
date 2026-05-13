// Coord-mediated playground client. Replaces the direct ws://localhost:8765
// connection with REST against the active coord:
//
//   POST   ${coord}/api/playground/sessions             spawn engine binary
//   GET    ${coord}/api/playground/sessions/{id}        meta poll
//   POST   ${coord}/api/playground/sessions/{id}/run    fire RUN, inline result
//   DELETE ${coord}/api/playground/sessions/{id}        stop
//
// The session-create body needs a binary path + dataset/indicators/set
// paths. UI doesn't know those literally — they're per-deploy. Default
// values come from VITE_PLAYGROUND_DEFAULTS in .env.local; user can
// override per-session via a Settings drawer (v2). For v1 we ship one
// preset that matches the dev box's checkout layout.

import { useEffect, useState } from 'react';
import { activeCoordFor, subscribeCoordChangeFor } from './coords';

const DEFAULTS = parseDefaults(import.meta.env.VITE_PLAYGROUND_DEFAULTS);

function parseDefaults(raw) {
  // VITE_PLAYGROUND_DEFAULTS = "binary=...;dataset_base=...;indicators=...;set_path=...;symbol=MNQ"
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

const coordBase = () => activeCoordFor('playground')?.url || '';

let session = null;          // {session_id, ...meta} or null
let status = 'disconnected'; // 'connecting' | 'ready' | 'error' | 'disconnected'
let lastError = null;
const statusListeners = new Set();

function setStatus(s) { status = s; for (const l of statusListeners) l(s); }

export function getDefaults() { return DEFAULTS; }
export function getSession() { return session; }
export function getLastError() { return lastError; }

// Spawn a session on the active coord. `overrides` may carry any of
// {binary,dataset_base,indicators,set_path,symbol,tick_size,tick_value,m2atrs}
// to replace the defaults.
export async function start(overrides = {}) {
  const body = { ...(DEFAULTS || {}), ...overrides };
  const required = ['binary', 'dataset_base', 'indicators', 'set_path'];
  const missing = required.filter(k => !body[k]);
  if (missing.length) {
    lastError = `playground defaults missing: ${missing.join(', ')} ` +
                `(set VITE_PLAYGROUND_DEFAULTS in .env.local or pass overrides)`;
    setStatus('error');
    throw new Error(lastError);
  }
  setStatus('connecting');
  lastError = null;
  try {
    const r = await fetch(`${coordBase()}/api/playground/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => `HTTP ${r.status}`);
      throw new Error(`session create failed: ${text}`);
    }
    session = await r.json();
    if (session.state !== 'ready') {
      throw new Error(`session not ready: ${session.state} ${session.error || ''}`);
    }
    setStatus('ready');
    return session;
  } catch (e) {
    lastError = e.message || String(e);
    setStatus('error');
    throw e;
  }
}

export async function stop() {
  if (!session) return;
  try {
    await fetch(`${coordBase()}/api/playground/sessions/${session.session_id}`, {
      method: 'DELETE',
    });
  } catch {}
  session = null;
  setStatus('disconnected');
}

// Send one RUN; returns {run_id, params, stats, trades, wall_ms, ts}.
export async function sendRun(params) {
  if (!session) {
    throw new Error('no session — call start() first');
  }
  const r = await fetch(
    `${coordBase()}/api/playground/sessions/${session.session_id}/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }
  );
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`run failed: ${text}`);
  }
  return r.json();
}

// React hook — same surface as the WS client had.
export function useWsStatus() {
  // Name kept ('useWsStatus') so LabPlayground.jsx doesn't have
  // to change. Actually returns coord-session status now.
  const [s, setS] = useState(status);
  useEffect(() => {
    statusListeners.add(setS);
    return () => statusListeners.delete(setS);
  }, []);
  return s;
}

// Stop session if user switches the playground coord (would otherwise
// be hitting the wrong coord on subsequent runs).
subscribeCoordChangeFor('playground', () => {
  if (session) stop();
});

// Compatibility shim for the existing route's `connect()` call
// (autoconnect on mount). With coord-mediated sessions we want
// explicit user action (Settings → Start session), so this no-ops
// for now and the UI surfaces a Connect button.
export function connect() { /* no-op — see Settings drawer (v2) */ }
export function disconnect() { stop(); }
export function isConnected() { return status === 'ready'; }
export function getHello() {
  if (!session) return null;
  return {
    param_names:    session.param_names,
    default_params: session.default_params,
  };
}
