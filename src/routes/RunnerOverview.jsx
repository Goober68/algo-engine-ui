// Runner panel — denser pass.
// Top: control bar with stats inline.
// Middle: slot grid (3 cards) | cross-slot equity (right) — side by side.
// Bottom: trade timeline full width.

import { useParams } from 'react-router-dom';
import { useRunner, useRunMeta, useSlotData } from '../data/MockDataProvider';
import RunnerControlBar from '../components/runner/RunnerControlBar';
import RunnerStatsStrip from '../components/runner/RunnerStatsStrip';
import SlotGrid from '../components/runner/SlotGrid';
import CompareEquity from '../components/runner/CompareEquity';
import TradeTimeline from '../components/runner/TradeTimeline';

export default function RunnerOverview() {
  const { id } = useParams();
  const runner = useRunner(id);
  const meta = useRunMeta(id);
  const s0 = useSlotData(id, 0);
  const s1 = useSlotData(id, 1);
  const s2 = useSlotData(id, 2);
  const slotsData = [s0, s1, s2];

  if (!runner || !meta) return <div className="p-3 text-muted text-xs">Loading runner {id}…</div>;
  if (slotsData.some(d => !d)) return <div className="p-3 text-muted text-xs">Loading slot data…</div>;

  return (
    <div className="flex flex-col gap-2 p-2 overflow-y-auto text-xs">
      <RunnerControlBar runner={runner} meta={meta} />
      <RunnerStatsStrip slotsData={slotsData} />
      <div className="grid grid-cols-[400px_1fr] gap-2">
        <SlotGrid runnerId={id} meta={meta} slotsData={slotsData} />
        <CompareEquity meta={meta} slotsData={slotsData} />
      </div>
      <TradeTimeline meta={meta} slotsData={slotsData} />
    </div>
  );
}
