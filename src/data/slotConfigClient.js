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

// Engine ships POST /r/{rid}/s/{N}/reinit eventually -- per L131/L132
// of the COORDINATION Stream. Until then this rejects loudly so the
// UI doesn't pretend a no-op succeeded.
export async function applySlotConfig(/*runnerId, slotIdx, cfgPatch*/) {
  throw new Error(
    "Apply not wired -- engine-side POST /r/{rid}/s/{N}/reinit not " +
    "shipped yet. Tracking via COORDINATION Stream L131/L132 (snapshot/" +
    "restore + per-slot reinit endpoint)."
  );
}
