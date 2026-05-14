// Data-windows client. Coord-side endpoints live on the FARM coord
// (where tick_data_root + data_windows_dir are set in
// coord_config.toml). Reuses the 'sweep' scope from coords.js since
// the sweep coord IS the farm coord -- same host that owns the
// build job + active selection that sweep submits will pick up.
//
// Endpoints:
//   GET    ${coord}/api/data-windows                     {windows, active_id, building?}
//   PUT    ${coord}/api/data-windows/active              body:{window_id} -> {active_id}
//   GET    ${coord}/api/data-windows/preflight?from=&to= {span_days, est_*}
//   POST   ${coord}/api/data-windows                     body:{symbol, from, to} -> {job_id, ...}
//   GET    ${coord}/api/data-windows/builds/{id}/events  SSE: hello/progress/stdout/done
//   DELETE ${coord}/api/data-windows/{window_id}         remove pair (clears active if it WAS)

import { activeCoordFor } from './coords';

const coordBase = () => activeCoordFor('sweep')?.url || '';

export async function listDataWindows() {
  const r = await fetch(`${coordBase()}/api/data-windows`);
  if (!r.ok) throw new Error(`list windows failed: HTTP ${r.status}`);
  return r.json();
}

export async function setActiveDataWindow(windowId) {
  const r = await fetch(`${coordBase()}/api/data-windows/active`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ window_id: windowId }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`set active failed: ${text}`);
  }
  return r.json();
}

export async function preflightDataWindow(frm, to) {
  const u = new URL(`${coordBase()}/api/data-windows/preflight`);
  u.searchParams.set('from', frm);
  u.searchParams.set('to', to);
  const r = await fetch(u);
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`preflight failed: ${text}`);
  }
  return r.json();
}

export async function buildDataWindow({ symbol, frm, to }) {
  const r = await fetch(`${coordBase()}/api/data-windows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, from: frm, to }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`build submit failed: ${text}`);
  }
  return r.json();   // {job_id, window_id, state}
}

export async function deleteDataWindow(windowId) {
  const r = await fetch(`${coordBase()}/api/data-windows/${encodeURIComponent(windowId)}`, {
    method: 'DELETE',
  });
  if (!r.ok && r.status !== 404) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`delete failed: ${text}`);
  }
  return r.ok;
}

// Open an EventSource for a running build's progress stream. Hands
// each named event to onEvent({type, data}). Returns the EventSource
// so the caller can .close() (e.g. on unmount or 'done').
export function openBuildEvents(jobId, onEvent) {
  const url = `${coordBase()}/api/data-windows/builds/${encodeURIComponent(jobId)}/events`;
  const es = new EventSource(url);
  for (const type of ['hello', 'progress', 'stdout', 'done']) {
    es.addEventListener(type, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch {}
      onEvent({ type, data });
    });
  }
  es.onerror = (e) => onEvent({ type: 'error', data: { error: e?.message || 'sse error' } });
  return es;
}
