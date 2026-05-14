// Decode the playground / viz-json `decisions` stream into a flat array
// of per-record objects -- the shape every consumer (ChartPane,
// TradeTable, StrategyStatePanel, HistoricalPane) already speaks.
//
// Engine 54999da shipped a Phase 1 columnar wire format: one parent
// object holding N typed-arrays + a nested `xovd` object of M typed-
// arrays. Older viz.json files (and any pre-54999da RUN response)
// still ship the per-record array form. This shim accepts both.
//
// Columnar shape:
//   { n, ts_ns:[...], bar_idx:[...], blocked_layer:[...],
//     infra_gate:[...], session_gate:[...], algo_gate:[...],
//     trading_gate:[...], entry_limit:[...], sl_ticks:[...],
//     entry_path:[...], order_placed:[...],
//     xovd: { state:[...], fast_ma:[...], slow_ma:[...],
//             atr:[...], close:[...], entry_limit_slow:[...] } }
//
// Per-record shape (legacy / viz.json):
//   [ { ts_ns, bar_idx, ..., xovd: {...} }, ... ]
//
// Returns [] for null/undefined/empty inputs.
export function expandDecisions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'object') return [];
  const n = raw.n ?? 0;
  if (!n) return [];

  const xovdCols = raw.xovd && typeof raw.xovd === 'object' ? raw.xovd : null;
  // Top-level keys = every entry except `n` and `xovd` itself. Lets new
  // engine-side fields (is_warmup, etc.) flow through without a code
  // change here, as long as they ship as N-length arrays.
  const topKeys = Object.keys(raw).filter(k => k !== 'n' && k !== 'xovd');
  const xovdKeys = xovdCols ? Object.keys(xovdCols) : [];

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const rec = {};
    for (const k of topKeys) {
      const arr = raw[k];
      if (Array.isArray(arr) && i < arr.length) rec[k] = arr[i];
    }
    if (xovdCols) {
      const x = {};
      for (const k of xovdKeys) {
        const arr = xovdCols[k];
        if (Array.isArray(arr) && i < arr.length) x[k] = arr[i];
      }
      rec.xovd = x;
    }
    out[i] = rec;
  }
  return out;
}
