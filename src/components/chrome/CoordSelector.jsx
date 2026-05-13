// Header-bar coord selector. Renders only when VITE_ALGO_COORDS lists
// more than one coord (or is set at all). Clicking opens a small popover
// of available coords; selecting one persists to localStorage and pings
// subscribers so dependent data providers re-fetch.

import { useEffect, useRef, useState } from 'react';
import { activeCoord, listCoords, setActiveCoord, subscribeCoordChange } from '../../data/coords';

export default function CoordSelector() {
  const all = listCoords();
  const [active, setActive] = useState(activeCoord());
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => subscribeCoordChange(() => setActive(activeCoord())), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (all.length <= 1) return null;   // single coord — nothing to switch

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="px-2 py-0.5 rounded text-[11px] tnum bg-bg border border-border hover:border-accent text-text"
        title={`Active coord: ${active?.name} (${active?.url})`}
      >
        coord · <span className="text-accent">{active?.name || '—'}</span>
        <span className="text-muted ml-1">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 top-full right-0 mt-1 w-72 bg-panel border border-border rounded shadow-lg text-xs">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted border-b border-border">
            Active coord
          </div>
          {all.map(c => {
            const isActive = c.name === active?.name;
            return (
              <button
                key={c.name}
                onClick={() => { setActiveCoord(c.name); setOpen(false); }}
                className={'w-full text-left px-2 py-1 hover:bg-accent/10 ' +
                           (isActive ? 'bg-accent/15' : '')}
              >
                <div className={isActive ? 'text-accent font-semibold' : 'text-text'}>
                  {c.name}
                </div>
                <div className="text-muted text-[10px] truncate">{c.url}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
