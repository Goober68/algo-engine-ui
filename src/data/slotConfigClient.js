// Per-slot live-config client. Reads the runner's currently-deployed
// strategy params for one slot (so the SlotConfigDrawer can populate
// its editor with the real baseline) and POSTs edits to coord, which
// bridges to the engine via the file-protocol reinit.
//
// The 7 indicator-shape keys (fastPeriod/slowPeriod/atrPeriod,
// fast/slowMaType, fast/slowSource) used to require a runner restart
// because streaming Rma/Sma/Ema/Atr accumulators bake alpha + window
// at xovdV1Init. Engine ad16711 lifted that restriction by warmup-
// replaying the runner's 500-bar ring with the new cfg before swap-in,
// so they're now hot-swappable like every other param. Ack returns
// shape_changed:true on success so the UI can surface the slower
// (~ms vs sub-ms) apply path. We keep the Set around to drive a soft
// visual hint that "this triggers a warmup-replay" -- still distinct
// from a same-shape reinit.

import { activeCoordFor } from './coords';

const coordBase = () => activeCoordFor('runners')?.url || '';

export const SHAPE_CHANGE_KEYS = new Set([
  'fastPeriod', 'slowPeriod', 'atrPeriod',
  'fastMaType', 'slowMaType',
  'fastSource', 'slowSource',
]);

export async function fetchSlotConfig(runnerId, slotIdx) {
  const url = `${coordBase()}/r/${runnerId}/s/${slotIdx}/config`;
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`fetch slot config failed: ${text}`);
  }
  return r.json();   // { runner_id, slot_idx, config, source }
}

// POST the slot's full edited config to coord, which atomic-writes
// pending_reinit_slot{N}.jsonl into the runner's log_dir. The engine's
// file watcher fires within ~10ms; runner queues + drains at top of
// the next tick (~250ms). Coord polls reinit_slot{N}_ack.json and
// returns the ack JSON to us.
//
// Ack shape: { slot_idx, request_ts_ns, applied_ts_ns, ok, shape_changed,
//              error }
//
// Throws on:
//   - HTTP error (network, 4xx, 5xx) -- caller surfaces e.message
//   - ack timeout (coord 504) -- pending file IS on disk; runner will
//     apply on the next tick. Caller can choose to refetch config to
//     see if it landed.
//
// Returns ack as-is. UI inspects ack.ok / ack.shape_changed to render
// the right toast.
export async function applySlotConfig(runnerId, slotIdx, cfgPatch) {
  const url = `${coordBase()}/r/${runnerId}/s/${slotIdx}/reinit`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cfg: cfgPatch }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`reinit failed: ${text}`);
  }
  return r.json();
}
