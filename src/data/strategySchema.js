// Fetches the strategy schema from coord. Tries the active coord
// first, falls back to other configured coords (schemas are usually
// hosted by the local-dev coord that lives alongside algo-engine).
// Caches per-strategy in module scope; the cache is keyed by coord
// URL so a CoordSelector switch refetches automatically.

import { activeCoordFor, allCoords } from './coords';

const SCHEMA_SCOPE = 'playground';   // schemas served by whichever coord hosts the engine binary; share with playground scope

const cache = new Map();   // key = `${coordUrl}|${strategy}` → schema

export async function fetchStrategySchema(strategy) {
  const active = activeCoordFor(SCHEMA_SCOPE);
  const order = [
    active,
    ...allCoords().filter(c => c?.name !== active?.name),
  ].filter(Boolean);

  let lastErr = null;
  for (const c of order) {
    const key = `${c.url}|${strategy}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const r = await fetch(`${c.url}/strategy-schema/${encodeURIComponent(strategy)}`);
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      const schema = await r.json();
      cache.set(key, schema);
      return schema;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no coord configured');
}
