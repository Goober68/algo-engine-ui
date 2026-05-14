// Bottom drawer with three SIDE-BY-SIDE panes:
//   stdout (left) | stderr (middle) | relay-audit orders (right).
// Runner stdout (status/bar/relay heartbeats), stderr (errors +
// warnings), and the relay-audit POST stream tell different parts of
// the same story and are often time-correlated; keeping all three
// side-by-side beats tab-toggling.
//
// Line colorations lifted from runner/dashboard/static/dashboard.js +
// dashboard.css so operator muscle memory from the old UI carries over.

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useRunnerLogs } from '../../data/MockDataProvider';
import { usePersistedSize } from '../chrome/usePersistedSize';
import Splitter from '../chrome/Splitter';
import OrdersPanel from './OrdersPanel';

const COLLAPSED_PX = 28;
const DEFAULT_OPEN_PX = 240;

export default function LogsDrawer({ slotIdx, drawerPx, setDrawerPx, data, setSelectedTradeKey }) {
  const { id: runnerId } = useParams();
  const open = drawerPx > COLLAPSED_PX + 4;
  const toggleOpen = () => setDrawerPx(open ? COLLAPSED_PX : DEFAULT_OPEN_PX);
  // Pane widths within the drawer. stdout + audit are fixed; stderr
  // takes the remainder. All persisted across sessions.
  const [stdoutPx, setStdoutPx] = usePersistedSize('logsdrawer.stdoutPx', 480);
  const [auditPx,  setAuditPx]  = usePersistedSize('logsdrawer.auditPx',  340);
  // Watch stderr passively even when the drawer is collapsed, so the
  // header badge can scream when something broke without requiring the
  // operator to open the drawer first.
  const stderrLines = useRunnerLogs(runnerId, 'stderr', 500);
  const errCount = stderrLines.filter(isErrLine).length;

  return (
    <div className="h-full border-t border-border bg-panel flex flex-col">
      <div className="flex items-center px-2 py-0.5 border-b border-border text-xs">
        <button
          onClick={toggleOpen}
          className="text-muted hover:text-text mr-3 inline-flex items-center gap-1.5"
        >
          <span>{open ? '▾' : '▸'} logs</span>
          {errCount > 0 && (
            <span
              title={`${errCount} error/failed/traceback line${errCount === 1 ? '' : 's'} in stderr`}
              className="px-1.5 rounded bg-short/20 text-short border border-short/50 text-[10px] tnum font-semibold animate-pulse"
            >
              {errCount} err
            </span>
          )}
        </button>
        {open && (
          <span className="text-muted text-[10px]">
            stdout · stderr · audit (drag splitters to resize)
          </span>
        )}
      </div>
      {open && (
        <div className="flex-1 min-h-0 flex">
          <div className="flex flex-col min-w-0" style={{ width: stdoutPx }}>
            <ProcessLogPane runnerId={runnerId} kind="stdout" />
          </div>
          <Splitter dir="col" size={stdoutPx} setSize={setStdoutPx} min={160} max={2000} />
          <div className="flex flex-col flex-1 min-w-0">
            <ProcessLogPane runnerId={runnerId} kind="stderr" />
          </div>
          <Splitter dir="col" size={auditPx} setSize={setAuditPx} min={200} max={1200} invert />
          <div className="flex flex-col min-w-0" style={{ width: auditPx }}>
            <OrdersPanel data={data} setSelectedTradeKey={setSelectedTradeKey} />
          </div>
        </div>
      )}
    </div>
  );
}

export function PaneHeader({ label, tail, setTail }) {
  return (
    <div className="px-2 py-0.5 flex items-center justify-between bg-bg/40 border-b border-border">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      {setTail && <TailPill tail={tail} setTail={setTail} />}
    </div>
  );
}

// Pill toggle lifted from tv-broker-relay/EdgeTail. TAIL = auto-scroll
// to bottom on new data; SCROLL = free (operator is reading something
// mid-stream and doesn't want the view to jump).
function TailPill({ tail, setTail }) {
  return (
    <button
      onClick={() => setTail(!tail)}
      title={tail ? 'Auto-scroll ON (click to free-scroll)' : 'Free-scroll (click to follow tail)'}
      className={
        'px-1.5 py-0 rounded text-[9px] font-semibold tracking-wide border ' +
        (tail
          ? 'border-accent/40 text-accent bg-accent/10'
          : 'border-border text-muted hover:text-text')
      }
    >
      {tail ? 'TAIL' : 'SCROLL'}
    </button>
  );
}

// Per-line color rules lifted from runner/dashboard/static/dashboard.js
// + dashboard.css. Same triggers, same hexes.
//   [bar]            -> blue   (per-bar info)
//   [status]         -> amber  (periodic heartbeat)
//   [relay-dryrun]   -> accent
//   [relay]          -> accent
//   error/failed/tb  -> red
//   stderr default   -> dim red so the whole stream reads as "needs eyes"
function isErrLine(line) {
  if (!line) return false;
  const l = line.toLowerCase();
  return l.includes('error') || l.includes('failed') || l.includes('traceback');
}

function logLineCls(line, kind) {
  if (!line) return '';
  if (line.startsWith('[bar]'))           return 'text-buy';
  if (line.startsWith('[status]'))        return 'text-trail';
  if (line.startsWith('[relay-dryrun]'))  return 'text-accent';
  if (line.startsWith('[relay]'))         return 'text-accent';
  if (isErrLine(line))                    return 'text-short';
  return kind === 'stderr' ? 'text-short/70' : '';
}

function ProcessLogPane({ runnerId, kind }) {
  const lines = useRunnerLogs(runnerId, kind, 500);
  const ref = useRef(null);
  // Explicit TAIL/SCROLL toggle. Independent of mouse-scroll: the
  // operator clicks SCROLL to freeze the view while inspecting; clicks
  // TAIL to resume following live data. (Older mouse-scroll auto-detect
  // surprised users by silently switching modes.)
  const [tail, setTail] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !tail) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, tail]);
  return (
    <>
      <PaneHeader label={kind} tail={tail} setTail={setTail} />
      <div ref={ref}
           className="flex-1 overflow-y-auto overflow-x-hidden p-2 text-[11px] font-mono text-muted leading-tight">
        {lines.length === 0
          ? <span className="italic">no {kind} lines yet</span>
          : lines.map((l, i) => (
              <div key={i} className={'truncate ' + logLineCls(l, kind)} title={l || undefined}>
                {l || ' '}
              </div>
            ))
        }
      </div>
    </>
  );
}
