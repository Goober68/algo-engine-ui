// Toolbar pill that summarizes the current session config and pops
// the shared SessionWindowsEditor on click. Used by LabPlayground +
// LabSweeps toolbars so the same control we ship in SlotConfigDrawer
// is reused instead of reinventing.
//
// State (mode, tz, windows) lives in the parent route; this component
// just renders + dispatches changes. Persistence is the parent's
// responsibility (LabPlayground tracks "applied" vs "picker" like the
// date range; LabSweeps holds it as a single submit-time config).

import { useEffect, useRef, useState } from 'react';
import SessionWindowsEditor, { DEFAULT_SESSIONS } from '../slot/SessionWindowsEditor';

export const DEFAULT_SESSION = {
  mode:    'include',
  tz:      'America/New_York',
  windows: DEFAULT_SESSIONS,
};

// `value` = {mode, tz, windows}; `onChange` fires with merged next.
// `dirty` shows the apply button (parent passes when applied !== value).
export default function SessionChip({ value, onChange, dirty, onApply, applyLabel, footnote }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  // Click-outside-to-close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = summariseSession(value);
  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1.5">
      <span className="text-muted text-[10px] uppercase tracking-wide">session</span>
      <button
        onClick={() => setOpen(o => !o)}
        title="Edit session windows"
        className={'px-1.5 py-0.5 rounded border text-[11px] tnum ' +
          (open
            ? 'bg-accent/20 text-accent border-accent/50'
            : 'bg-bg text-text border-border hover:border-accent/50')}
      >
        {summary}
      </button>
      {onApply && (
        <button
          onClick={onApply}
          disabled={!dirty}
          className={'px-2 py-0.5 rounded border text-[11px] ' + (dirty
            ? 'bg-accent/20 text-accent border-accent/40 hover:bg-accent/30'
            : 'border-border text-muted opacity-40')}
          title={dirty ? 'apply session changes' : 'no pending change'}
        >
          {applyLabel || 'Apply'}
        </button>
      )}
      {open && (
        <div className="absolute top-full mt-1 left-0 z-30 w-[480px]
                        bg-panel border border-border rounded shadow-2xl">
          <SessionWindowsEditor
            mode={value.mode}
            tz={value.tz}
            windows={value.windows}
            onChange={(m, t, w) => onChange({ mode: m, tz: t, windows: w })}
            footnote={footnote}
          />
        </div>
      )}
    </div>
  );
}

// "include · 3w · NY" / "exclude · 0w · ET" / etc. Compact enough for
// a toolbar pill while still telling the operator what'll happen.
function summariseSession({ mode, tz, windows }) {
  const tzShort = SHORT_TZ[tz] || tz.split('/').pop();
  const n = (windows || []).length;
  return `${mode} · ${n}w · ${tzShort}`;
}

const SHORT_TZ = {
  'America/New_York':  'NY',
  'America/Chicago':   'CHI',
  'Europe/London':     'LDN',
  'Europe/Berlin':     'BER',
  'Asia/Tokyo':        'TYO',
  'Asia/Hong_Kong':    'HKG',
  'Australia/Sydney':  'SYD',
};

// Per-tab persistence helper, mirrors usePersistedRange's shape.
// Scope key 'playground' / 'sweep' so the two tabs keep independent
// session configs.
const LS_KEY = (scope) => `algoengine.session.v1.${scope}`;

export function usePersistedSession(scope, fallback = DEFAULT_SESSION) {
  const [v, setV] = useState(() => {
    try {
      const raw = window.localStorage.getItem(LS_KEY(scope));
      if (raw) return { ...fallback, ...JSON.parse(raw) };
    } catch {}
    return fallback;
  });
  useEffect(() => {
    try { window.localStorage.setItem(LS_KEY(scope), JSON.stringify(v)); } catch {}
  }, [scope, v]);
  return [v, setV];
}
