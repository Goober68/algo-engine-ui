// HistoricalDataProvider — pure file-input adapter that turns a
// strategy-visualizer .viz.json into the SAME slot-data shape
// SlotView's components (ChartPane, TradeTable, SlotHeader) already
// expect.
//
// Why this exists: ChartPane / TradeTable already implement everything
// the standalone strategy-visualizer/index.html does and more (gate
// hover, eligibility shading from decisions, bar aggregation). For the
// historical-review tab we just need to feed the same shape from a
// dropped viz.json instead of from coord NDJSON.
//
// Schema note: as of build_visualizer_data.py 2026-05-13, viz.json
// bundles a `decisions` array alongside bars/indicators/trades, so a
// single file carries everything the historical tab needs (no more
// pairing with a sibling .events.jsonl).
//
// Output shape (matches MockDataProvider.useSlotData's return):
//   {
//     bars:      [{ts_ns, bar_idx, open, high, low, close, volume,
//                  fast_ma, slow_ma, atr}],
//     trades:    [{trade_id, side, qty, entry_ts, entry_px, exit_ts,
//                  exit_px, pnl, reason, comm}],
//     broker:    same as trades (no separate broker truth historically)
//     decisions: passthrough of viz.json's decisions array (or [] for
//                old viz.json files without the bundled stream)
//     audit:     [] (webhook POSTs don't exist in historical replays)
//   }
//
// Plus a synthesized slotMeta + meta so SlotHeader and the parent
// route can render without further plumbing.

const DIR_TO_SIDE = { LONG: 'long', SHORT: 'short' };
const REASON_MAP = {
  TP: 'tp', SL: 'sl', TRAIL: 'trail',
  NONE: 'none', CROSS: 'cross', MAXBARS: 'maxbars', EOSTREAM: 'eostream',
};

// viz.json bars are seconds-based + indicators in a parallel array.
// Engine-ui wants nanosecond ts + indicators merged per-bar.
function mergeVizBars(vizBars, vizInds) {
  const indByTime = new Map();
  for (const r of (vizInds || [])) indByTime.set(r.time, r);
  return vizBars.map((b, i) => {
    const ind = indByTime.get(b.time) || {};
    return {
      ts_ns:   b.time * 1e9,
      bar_idx: i,
      open:    b.open, high: b.high, low: b.low, close: b.close,
      volume:  b.volume,
      fast_ma: ind.fast_ma || 0,
      slow_ma: ind.slow_ma || 0,
      atr:     ind.atr     || 0,
    };
  });
}

function vizTradesToBroker(vizTrades) {
  // viz schema: {id, dir, size, entry_time, entry_price, exit_time,
  //              exit_price, exit_reason, profit, sl_price, tp_price}
  return (vizTrades || []).map(t => ({
    trade_id: t.id,
    side:     DIR_TO_SIDE[t.dir] || (t.dir || '').toLowerCase(),
    qty:      t.size,
    entry_ts: t.entry_time * 1e9,
    entry_px: t.entry_price,
    exit_ts:  t.exit_time * 1e9,
    exit_px:  t.exit_price,
    pnl:      t.profit,
    reason:   REASON_MAP[t.exit_reason] || (t.exit_reason || '').toLowerCase(),
    comm:     0,            // viz schema has no commission
    sl_price: t.sl_price || 0,
    tp_price: t.tp_price || 0,
  }));
}

// Synthesize a minimal slotMeta so SlotHeader renders. We hijack the
// `account` field for the bold viz filename (SlotHeader renders it
// prominently next to "Slot N").
function synthSlotMeta(viz, label, fileNames = {}) {
  const cfg = viz.config || {};
  const vizName = fileNames.viz || viz.meta?.source || label || 'historical';
  return {
    slot_idx: 0,
    account:  vizName,
    label:    '',
    live:     false,
    n_bars:   viz.bars?.length || 0,
    n_trades: viz.trades?.length || 0,
    n_broker: viz.trades?.length || 0,
    config:   cfg,
  };
}

// Synthesize a run-level meta so the parent route has symbol/period.
function synthRunMeta(viz) {
  return {
    run_id:         'historical',
    kind:           'historical',
    symbol:         viz.meta?.symbol || 'unknown',
    bar_period_sec: viz.meta?.bar_period_sec || 180,
    slots:          [],
  };
}

// Main entry point: receive raw viz.json text, return the assembled
// slot-data shape + synthesized meta. The decisions stream (used for
// eligibility shading + per-bar gate hover) lives inside viz.json as
// of 2026-05-13's build_visualizer_data.py change; old files without
// a `decisions` array just get an empty stream and no gate viz.
export function buildHistoricalData(vizText, label, fileNames = {}) {
  const viz = JSON.parse(vizText);
  if (!viz || !Array.isArray(viz.bars) || !Array.isArray(viz.trades)) {
    throw new Error('not a strategy-visualizer .viz.json (missing bars/trades)');
  }
  const bars     = mergeVizBars(viz.bars, viz.indicators);
  const broker   = vizTradesToBroker(viz.trades);
  // trades vs broker: SlotHeader computes "delta" between algo-sim and
  // real-broker. For a historical replay both are the same source, so
  // set them identical -- delta will be 0, which is the truth.
  const trades   = broker;
  const decisions = Array.isArray(viz.decisions) ? viz.decisions : [];

  return {
    data:     { bars, trades, broker, decisions, audit: [] },
    slotMeta: synthSlotMeta(viz, label, fileNames),
    runMeta:  synthRunMeta(viz),
    aggregate: viz.aggregate || null,
    rawConfig: viz.config || {},
    fileNames: { viz: fileNames.viz || null },
  };
}
