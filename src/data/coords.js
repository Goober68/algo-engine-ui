// Multi-coord topology — one host per coord. UI may know about several
// at once (typically VPS-for-runners + Local-for-historical/playground/
// sweep). Source of truth: VITE_ALGO_COORDS env var.
//
//   VITE_ALGO_COORDS = "vps@http://192.168.1.203:8090,local@http://192.168.1.17:8091"
//
// Each comma-separated entry is `<label>@<url>`. Backwards-compat: if
// only legacy VITE_ALGO_COORD_URL is set, treated as single-coord
// labeled "primary".
//
// Per-tab active coord (Niall direction 2026-05-13):
//
//   Different tabs typically want different coords at the same time.
//   Live runner data lives on VPS, but engine workloads (playground,
//   sweep) want local-or-GPU subprocess access. Switching the global
//   active coord broke the live runner view every time the user
//   tweaked a slider.
//
//   Resolution: each "scope" persists its own active coord. A scope
//   is a free-form key the consumer picks (route path, feature name,
//   etc.). CoordSelector switches the CURRENT scope's coord; default
//   per scope is consulted on first use.

const RAW = (import.meta.env.VITE_ALGO_COORDS || '').trim();
const LEGACY = (import.meta.env.VITE_ALGO_COORD_URL || '').replace(/\/+$/, '');

function parse(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const at = s.indexOf('@');
    if (at < 0) return { name: s, url: s };
    return {
      name: s.slice(0, at).trim(),
      url:  s.slice(at + 1).trim().replace(/\/+$/, ''),
    };
  });
}

let COORDS = parse(RAW);
if (COORDS.length === 0 && LEGACY) {
  COORDS = [{ name: 'primary', url: LEGACY }];
}

// Per-scope persistence. Key = `algoengine.activeCoord.v2.<scope>`.
// V2 because v1 was global (single key).
const LS_KEY = (scope) => `algoengine.activeCoord.v2.${scope || 'global'}`;

// Default coord per scope, used only on first-ever visit to a scope.
// 'runners' anchors to the first vps-like coord (live runners on VPS);
// engine-workload scopes anchor to local. If only one coord is
// configured, all scopes share it.
function defaultFor(scope) {
  if (COORDS.length === 0) return null;
  if (COORDS.length === 1) return COORDS[0].name;
  // Heuristic: scopes that need engine subprocess go to the first
  // non-vps coord (typically 'local'); 'runners' goes to a coord
  // labeled vps if present, else first.
  const isEngineWorkload = (
    scope === 'historical' ||
    scope === 'playground' ||
    scope === 'sweep'
  );
  if (isEngineWorkload) {
    const local = COORDS.find(c => c.name !== 'vps');
    return (local || COORDS[0]).name;
  }
  // 'runners' / unknown — prefer vps if present.
  const vps = COORDS.find(c => c.name === 'vps');
  return (vps || COORDS[0]).name;
}

function readActive(scope) {
  try { return window.localStorage.getItem(LS_KEY(scope)) || null; } catch { return null; }
}
function writeActive(scope, name) {
  try { window.localStorage.setItem(LS_KEY(scope), name); } catch {}
}

// Per-scope active map (in memory, mirrors localStorage).
const activeByScope = new Map();
const listenersByScope = new Map();   // scope → Set<fn>

function ensureLoaded(scope) {
  if (activeByScope.has(scope)) return;
  const saved = readActive(scope);
  const valid = saved && COORDS.some(c => c.name === saved);
  activeByScope.set(scope, valid ? saved : defaultFor(scope));
}

// ── Public API ───────────────────────────────────────────────────────

export function listCoords() { return COORDS.slice(); }
export function allCoords() { return COORDS.slice(); }

export function activeCoordFor(scope) {
  ensureLoaded(scope);
  const name = activeByScope.get(scope);
  return COORDS.find(c => c.name === name) || COORDS[0] || null;
}

export function setActiveCoordFor(scope, name) {
  if (!COORDS.some(c => c.name === name)) return;
  activeByScope.set(scope, name);
  writeActive(scope, name);
  const ls = listenersByScope.get(scope);
  if (ls) for (const l of ls) l();
}

export function subscribeCoordChangeFor(scope, fn) {
  if (!listenersByScope.has(scope)) listenersByScope.set(scope, new Set());
  listenersByScope.get(scope).add(fn);
  return () => listenersByScope.get(scope)?.delete(fn);
}

// ── Legacy global API (kept until call sites migrate) ────────────────
// These read/write a single 'global' scope so existing consumers don't
// break mid-migration. New code should use the *For variants with an
// explicit scope.

export function activeCoord() { return activeCoordFor('global'); }
export function setActiveCoord(name) { setActiveCoordFor('global', name); }
export function subscribeCoordChange(fn) { return subscribeCoordChangeFor('global', fn); }

// ── React hook helper ────────────────────────────────────────────────
// Use this in components that should re-render when their scope's
// active coord changes. Returns the current active coord object.

import { useEffect, useState } from 'react';

export function useActiveCoord(scope) {
  const [c, setC] = useState(() => activeCoordFor(scope));
  useEffect(() => subscribeCoordChangeFor(scope, () => setC(activeCoordFor(scope))), [scope]);
  return c;
}
