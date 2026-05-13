// Header coord selector. Switches the CURRENT TAB's active coord
// (per-scope, persisted). Different routes operate on different
// scopes — the live runner view stays glued to VPS while you flip
// playground/sweep between local and a future GPU-box coord.
//
// Renders nothing when only one coord is configured (still useful?
// keep visible to display which coord you're on; but no dropdown).

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  activeCoordFor, listCoords, setActiveCoordFor, subscribeCoordChangeFor,
} from '../../data/coords';

// Route → scope mapping. Free-form scope names; coords.js uses them
// as localStorage keys so add new scopes here as new tabs land.
export function scopeForPath(pathname) {
  if (!pathname || pathname === '/') return 'runners';
  if (pathname.startsWith('/r/'))            return 'runners';
  if (pathname === '/runs')                   return 'runners';
  if (pathname.startsWith('/lab/playground')) return 'playground';
  if (pathname.startsWith('/lab/sweeps'))     return 'sweep';
  if (pathname.startsWith('/historical/'))    return 'historical';
  if (pathname === '/settings')               return 'runners';   // no coord need
  return 'runners';
}

export default function CoordSelector() {
  const location = useLocation();
  const scope = scopeForPath(location.pathname);
  const all = listCoords();
  const [active, setActive] = useState(() => activeCoordFor(scope));
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Re-subscribe when scope changes (different tab → different scope).
  useEffect(() => {
    setActive(activeCoordFor(scope));
    return subscribeCoordChangeFor(scope, () => setActive(activeCoordFor(scope)));
  }, [scope]);

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

  if (all.length === 0) return null;

  // With a single coord, render a static badge (no dropdown).
  if (all.length === 1) {
    return (
      <span className="px-2 py-0.5 rounded text-[11px] tnum text-muted">
        coord · <span className="text-text">{active?.name}</span>
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="px-2 py-0.5 rounded text-[11px] tnum bg-bg border border-border hover:border-accent text-text"
        title={`Active coord for "${scope}" scope: ${active?.name} (${active?.url})`}
      >
        <span className="text-muted">{scope} ·</span> <span className="text-accent">{active?.name || '—'}</span>
        <span className="text-muted ml-1">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 top-full right-0 mt-1 w-72 bg-panel border border-border rounded shadow-lg text-xs">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted border-b border-border">
            Active for <span className="text-accent">{scope}</span>
          </div>
          {all.map(c => {
            const isActive = c.name === active?.name;
            return (
              <button
                key={c.name}
                onClick={() => { setActiveCoordFor(scope, c.name); setOpen(false); }}
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
