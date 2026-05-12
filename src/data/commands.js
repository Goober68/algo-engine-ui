// Control-plane HTTP client for algo-coord.
// Mock mode (no VITE_ALGO_COORD_URL) returns fake success after a tick
// so the UI flow stays exercised in dev without a live coord.

const COORD = import.meta.env.VITE_ALGO_COORD_URL?.replace(/\/+$/, '') || '';
const REAL = COORD.length > 0;

async function postJson(path, params = {}) {
  if (!REAL) {
    // Mock: tiny latency, success.
    await new Promise(r => setTimeout(r, 200));
    return { ok: true, mock: true, action: path };
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${COORD}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.detail = body?.detail ?? body;
    throw err;
  }
  return body;
}

async function getJson(path) {
  if (!REAL) {
    await new Promise(r => setTimeout(r, 100));
    return { mock: true };
  }
  const res = await fetch(`${COORD}${path}`);
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  return res.json();
}

// ── Runner control ──────────────────────────────────────────────────

export const runnerControl = {
  status:        (id)            => getJson(`/r/${id}/status`),
  preflight:     (id)            => postJson(`/r/${id}/control/preflight`),
  start:         (id)            => postJson(`/r/${id}/control/start`),
  stop:          (id, force=false) => postJson(`/r/${id}/control/stop`, force ? { force: 'true' } : {}),
  restart:       (id, force=false) => postJson(`/r/${id}/control/restart`, force ? { force: 'true' } : {}),
  reconcileNow:  (id, account = null) =>
    postJson(`/r/${id}/control/reconcile-now`, account ? { account } : {}),
};

export const COMMAND_MODE = REAL ? 'coord' : 'mock';
