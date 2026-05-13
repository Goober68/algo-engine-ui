// Historical: side-by-side replay review. Two stacked HistoricalPane
// instances with synchronized time-scale. Time-sync logic lives here
// rather than inside HistoricalPane so the Single route doesn't pay
// the (otherwise harmless but unnecessary) subscription cost.

import { useRef } from 'react';
import HistoricalPane from '../components/historical/HistoricalPane';
import { usePersistedSize } from '../components/chrome/usePersistedSize';

export default function HistoricalSxS() {
  const [tf, setTf] = usePersistedSize('slotview.tf', 180);

  const chartA = useRef(null);
  const chartB = useRef(null);
  const syncBusy = useRef(false);

  // Subscribe FRESH to each chart instance that mounts (StrictMode-safe
  // — the OLD subscribers on the dead chart silently no-op). Each
  // subscriber reads the OTHER pane's chart from a ref so it always
  // forwards to whatever is current.
  const wireSync = (which) => (chart) => {
    if (which === 'A') chartA.current = chart;
    else               chartB.current = chart;
    const otherRef = (which === 'A') ? chartB : chartA;
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || syncBusy.current) return;
      const dest = otherRef.current;
      if (!dest) return;
      const cur = dest.timeScale().getVisibleLogicalRange();
      if (cur && Math.abs(cur.from - range.from) < 0.01
              && Math.abs(cur.to   - range.to)   < 0.01) return;
      syncBusy.current = true;
      try { dest.timeScale().setVisibleLogicalRange(range); }
      finally {
        // 50ms lockout — lightweight-charts dispatches range-change
        // subscribers on the next animation frame, so a microtask
        // unlock fires too early and re-triggers the loop.
        setTimeout(() => { syncBusy.current = false; }, 50);
      }
    });
    // Initial alignment once both panes are mounted: push A's range
    // onto B so they start in lockstep (each ChartPane restores its
    // own saved view from localStorage, so they can otherwise land on
    // different windows on a fresh page).
    if (chartA.current && chartB.current && which === 'B') {
      setTimeout(() => {
        const r = chartA.current?.timeScale().getVisibleLogicalRange();
        if (!r) return;
        syncBusy.current = true;
        try { chartB.current.timeScale().setVisibleLogicalRange(r); }
        finally { setTimeout(() => { syncBusy.current = false; }, 50); }
      }, 200);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <HistoricalPane label="A" tf={tf} setTf={setTf} onChartReady={wireSync('A')} />
      <div className="h-px bg-border" />
      <HistoricalPane label="B" tf={tf} setTf={setTf} onChartReady={wireSync('B')} />
    </div>
  );
}
