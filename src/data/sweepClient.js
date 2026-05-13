// Sweep client. POSTs a recipe to coord, opens an SSE event stream
// for live progress, and offers cancel + results-fetch helpers.
//
// Endpoints:
//   POST   ${coord}/api/sweeps                       create + spawn
//   GET    ${coord}/api/sweeps/{id}                  meta poll
//   GET    ${coord}/api/sweeps/{id}/events  (SSE)    progress stream
//   GET    ${coord}/api/sweeps/{id}/results          paginated results
//   DELETE ${coord}/api/sweeps/{id}                  cancel
//
// VITE_SWEEP_DEFAULTS in .env.local supplies the per-deploy paths
// (binary/bars/ticks/indicators) that the recipe doesn't carry. Same
// shape as VITE_PLAYGROUND_DEFAULTS — semicolon-delimited key=value.

import { activeCoordFor } from './coords';

const DEFAULTS = parseDefaults(import.meta.env.VITE_SWEEP_DEFAULTS);

function parseDefaults(raw) {
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

const coordBase = () => activeCoordFor('sweep')?.url || '';

export function getDefaults() { return DEFAULTS; }

// Submit a recipe. `recipePayload` is the toSubmitPayload() output:
// {strategy, recipe: {<key>: {fixed | sweep}, ...}}. `overrides` may
// supply binary/bars/ticks/indicators/no_session/no_slow_path/excludes
// to override the env defaults.
export async function submitSweep(recipePayload, overrides = {}) {
  const body = { ...(DEFAULTS || {}), ...overrides, ...recipePayload };
  // `binary` is no longer required from the UI -- coord resolves the
  // path per target via [target.<name>.binaries] in coord_config.toml.
  // Pass `binary` in overrides if you want to bypass that lookup.
  const required = ['bars', 'ticks', 'strategy', 'recipe'];
  const missing = required.filter(k => !body[k]);
  if (missing.length) {
    throw new Error(
      `sweep submission missing: ${missing.join(', ')} ` +
      `(set VITE_SWEEP_DEFAULTS in .env.local or pass overrides)`);
  }
  const r = await fetch(`${coordBase()}/api/sweeps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`sweep submit failed: ${text}`);
  }
  return r.json();   // {sweep_id, ...meta, materialized: {...}}
}

export async function getSweepMeta(sweepId) {
  const r = await fetch(`${coordBase()}/api/sweeps/${sweepId}`);
  if (!r.ok) throw new Error(`get sweep failed: HTTP ${r.status}`);
  return r.json();
}

export async function cancelSweep(sweepId) {
  const r = await fetch(`${coordBase()}/api/sweeps/${sweepId}`, {
    method: 'DELETE',
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`cancel failed: HTTP ${r.status}`);
  }
  return r.ok;
}

export async function fetchResults(sweepId, { offset = 0, limit = 1000 } = {}) {
  const u = new URL(`${coordBase()}/api/sweeps/${sweepId}/results`);
  u.searchParams.set('offset', offset);
  u.searchParams.set('limit', limit);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`results fetch failed: HTTP ${r.status}`);
  return r.json();
}

// Open an EventSource for a sweep's progress stream. The named SSE
// events are: hello, progress, stderr, ping, done. The handler is
// called with {type, data} for each. Returns the EventSource so the
// caller can .close() it (e.g. on unmount).
export function openSweepEvents(sweepId, onEvent) {
  const url = `${coordBase()}/api/sweeps/${sweepId}/events`;
  const es = new EventSource(url);
  for (const type of ['hello', 'progress', 'stderr', 'ping', 'done']) {
    es.addEventListener(type, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch {}
      onEvent({ type, data });
    });
  }
  es.onerror = (e) => onEvent({ type: 'error', data: { error: e?.message || 'sse error' } });
  return es;
}
