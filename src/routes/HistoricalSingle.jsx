// Historical: single-pane replay review. One HistoricalPane, no
// sync, no comparison stats. Same drag-drop / server-picker /
// swap-dropdown / gate-hover surface as the SxS mode.

import HistoricalPane from '../components/historical/HistoricalPane';
import { usePersistedSize } from '../components/chrome/usePersistedSize';

export default function HistoricalSingle() {
  const [tf, setTf] = usePersistedSize('slotview.tf', 180);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <HistoricalPane label="S" tf={tf} setTf={setTf} />
    </div>
  );
}
