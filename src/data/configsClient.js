// Saved-configs client (playground slider snapshots).
//
// Two storage tiers, both keyed by strategy:
//   - LOCAL  : localStorage (per browser; private/scratch)
//   - REMOTE : coord /api/playground/configs (shared across UI clients)
//
// API surface mirrors the two -- list/save/get/del with a `tier` arg.
// Each saved record is { id, name, strategy, values, created_at, notes,
// tier } where tier is added on the client side for display.

import { activeCoordFor } from './coords';

const LS_KEY = 'playground.configs.v1';
const coordBase = () => activeCoordFor('playground')?.url || '';

// ── Local (localStorage) ────────────────────────────────────────────

function loadLocalAll() {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveLocalAll(list) {
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch {}
}

function makeId() {
  return 'l_' + Math.random().toString(36).slice(2, 10);
}

export function listLocal(strategy) {
  const all = loadLocalAll();
  return all
    .filter(c => !strategy || c.strategy === strategy)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .map(c => ({ ...c, tier: 'local' }));
}
export function saveLocal({ name, strategy, values, notes = '' }) {
  const all = loadLocalAll();
  const cfg = {
    id: makeId(),
    name: String(name).trim() || '(unnamed)',
    strategy,
    values: { ...values },
    created_at: Date.now() / 1000,
    notes,
  };
  all.push(cfg);
  saveLocalAll(all);
  return { ...cfg, tier: 'local' };
}
export function getLocal(id) {
  const found = loadLocalAll().find(c => c.id === id);
  return found ? { ...found, tier: 'local' } : null;
}
export function deleteLocal(id) {
  saveLocalAll(loadLocalAll().filter(c => c.id !== id));
}

// ── Remote (coord) ──────────────────────────────────────────────────

export async function listRemote(strategy) {
  const u = new URL(`${coordBase()}/api/playground/configs`);
  if (strategy) u.searchParams.set('strategy', strategy);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`list remote configs failed: HTTP ${r.status}`);
  const d = await r.json();
  return (d.configs || []).map(c => ({ ...c, tier: 'remote' }));
}
export async function saveRemote({ name, strategy, values, notes = '' }) {
  const r = await fetch(`${coordBase()}/api/playground/configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, strategy, values, notes }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`save remote config failed: ${text}`);
  }
  const cfg = await r.json();
  return { ...cfg, tier: 'remote' };
}
export async function getRemote(id) {
  const r = await fetch(`${coordBase()}/api/playground/configs/${id}`);
  if (!r.ok) throw new Error(`get remote config failed: HTTP ${r.status}`);
  const cfg = await r.json();
  return { ...cfg, tier: 'remote' };
}
export async function deleteRemote(id) {
  const r = await fetch(`${coordBase()}/api/playground/configs/${id}`, {
    method: 'DELETE',
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`delete remote config failed: HTTP ${r.status}`);
  }
}

// ── Combined helpers ────────────────────────────────────────────────

export async function listAll(strategy) {
  // Remote may fail (offline coord); local is always available.
  const local = listLocal(strategy);
  let remote = [];
  try { remote = await listRemote(strategy); } catch {}
  return { local, remote };
}
