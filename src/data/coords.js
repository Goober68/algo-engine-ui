// Coord topology: ONE backend per host. UI may know about several
// at once (typically VPS-for-runners + Local-for-historical-files-
// and-schema). Source of truth: the VITE_ALGO_COORDS env var.
//
//   VITE_ALGO_COORDS = "vps@http://192.168.1.203:8090,local@http://127.0.0.1:8091"
//
// Each comma-separated entry is `<label>@<url>`. The first listed
// coord is the default active one; the active selection is then
// persisted to localStorage. Backwards-compat: if only the legacy
// VITE_ALGO_COORD_URL is set, we treat it as a single-coord list
// labeled "primary".

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

const LS_KEY = 'algoengine.activeCoord.v1';

function readActive() {
  try { return window.localStorage.getItem(LS_KEY) || null; } catch { return null; }
}
function writeActive(name) {
  try { window.localStorage.setItem(LS_KEY, name); } catch {}
}

// Initial active = persisted choice if still valid, else first listed.
let activeName = (() => {
  const saved = readActive();
  if (saved && COORDS.some(c => c.name === saved)) return saved;
  return COORDS[0]?.name || null;
})();

const listeners = new Set();

export function listCoords() { return COORDS.slice(); }
export function activeCoord() {
  return COORDS.find(c => c.name === activeName) || COORDS[0] || null;
}
export function setActiveCoord(name) {
  if (!COORDS.some(c => c.name === name)) return;
  activeName = name;
  writeActive(name);
  for (const l of listeners) l();
}
export function subscribeCoordChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Cross-coord helpers — used when a feature should fan-out across
// all configured coords (e.g. the historical-files picker lists files
// from local AND vps so the user can swap source per-file).
export function allCoords() { return COORDS.slice(); }
