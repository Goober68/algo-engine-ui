// Per-slot live-config client. Reads the runner's currently-deployed
// strategy params for one slot (so the SlotConfigDrawer can populate
// its editor with the real baseline), and stubs the apply path until
// engine-claude ships POST /r/{rid}/s/{N}/reinit.
//
// Fields that genuinely need a runner restart even though they're in
// the schema (per engine-claude's L130 audit): the 7 indicator-shape
// keys -- the streaming Rma/Sma/Ema/Atr accumulators bake alpha and
// window size at xovdV1Init, so changing them mid-flight gives ~5×
// period bars of garbage MAs. Drawer disables these with a tooltip
// explaining why.

import { activeCoordFor } from './coords';

const coordBase = () => activeCoordFor('runners')?.url || '';

export const RESTART_REQUIRED_KEYS = new Set([
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
