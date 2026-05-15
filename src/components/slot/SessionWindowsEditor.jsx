// Session-windows editor. Single source of truth for the (mode, tz,
// windows) trio across:
//   - SlotConfigDrawer (live runner config; hot-swap via reinit)
//   - LabPlayground toolbar (per-session, restart on Apply)
//   - LabSweeps toolbar (single fixed value applied to every config
//                        in the sweep run -- session is NOT swept)
//
// Same widget everywhere by design (per Niall direction); the only
// thing that varies between consumers is the contextual hint shown
// at the bottom of the editor (live = "hot-swap via reinit", etc.).
//
// Wire format matches engine: sessionMode in {'include','exclude'},
// sessionTz IANA name, sessionWindows = [{startHHMM, endHHMM, label?}].
// HHMM is packed-int (1530 = 15:30) to match the engine's
// SessionWindow struct in backtester/runtime/sessionMask.h.

import { MARKET_SESSIONS } from '../../data/marketSessions';

// Mirror of xovdDefaultSessions() in backtester/runtime/sessionMask.h.
// Engine falls back to these when sessionWindows is absent from a
// config row, so the UI seeds the editor with the same shape on
// fresh-state init.
export const DEFAULT_SESSIONS = [
  { startHHMM: 630,  endHHMM: 1155, label: 'S1' },
  { startHHMM: 1205, endHHMM: 1530, label: 'S2' },
  { startHHMM: 1705, endHHMM: 155,  label: 'S3 (wraps midnight)' },
];

export default function SessionWindowsEditor({ mode, tz, windows, onChange, footnote }) {
  const setMode = (m) => onChange(m, tz, windows);
  const setTz = (t) => onChange(mode, t, windows);
  const setWindows = (w) => onChange(mode, tz, w);
  const addWindow = () => setWindows([...windows, {
    startHHMM: 900, endHHMM: 1000, label: '',
  }]);
  const removeWindow = (i) => setWindows(windows.filter((_, j) => j !== i));
  const updateWindow = (i, patch) => setWindows(
    windows.map((w, j) => j === i ? { ...w, ...patch } : w)
  );
  return (
    <div className="px-2 py-2 text-[11px]">
      <div className="flex items-center gap-3 mb-2">
        <ModeRadio label="Allow only listed" value="include"
                   active={mode === 'include'} onClick={() => setMode('include')} />
        <ModeRadio label="Allow all except listed" value="exclude"
                   active={mode === 'exclude'} onClick={() => setMode('exclude')} />
        <div className="ml-auto flex items-center gap-1">
          <span className="text-[10px] uppercase text-muted tracking-wide">TZ</span>
          <TzSelect value={tz} onChange={setTz} />
        </div>
      </div>
      <div className="border border-border rounded">
        <div className="grid grid-cols-[88px_88px_1fr_24px] gap-1 px-2 py-1 text-[10px] uppercase text-muted tracking-wide bg-bg/40">
          <span>Start</span>
          <span>End</span>
          <span>Label</span>
          <span></span>
        </div>
        {windows.map((w, i) => (
          <div key={i} className="grid grid-cols-[88px_88px_1fr_24px] gap-1 px-2 py-1 items-center border-t border-border/30">
            <HhmmInput value={w.startHHMM} onChange={(v) => updateWindow(i, { startHHMM: v })} />
            <HhmmInput value={w.endHHMM}   onChange={(v) => updateWindow(i, { endHHMM: v })} />
            <input
              type="text"
              value={w.label || ''}
              placeholder="(optional)"
              onChange={(e) => updateWindow(i, { label: e.target.value })}
              className="px-1.5 h-5 bg-bg border border-border rounded text-text text-[11px]"
            />
            <button onClick={() => removeWindow(i)}
                    title="Remove window"
                    className="text-muted hover:text-short text-sm leading-none">×</button>
          </div>
        ))}
        {!windows.length && (
          <div className="px-2 py-2 text-muted">
            {mode === 'include' ? 'No windows -- engine will not trade.' : 'No exclusions -- engine trades 24h.'}
          </div>
        )}
      </div>
      <button onClick={addWindow}
              className="mt-2 px-2 py-0.5 rounded bg-bg border border-border hover:border-accent text-muted hover:text-text text-[11px]">
        + Add window
      </button>
      {footnote && (
        <div className="mt-2 text-[10px] text-muted leading-relaxed">
          {footnote}
        </div>
      )}
    </div>
  );
}

function ModeRadio({ label, active, onClick }) {
  return (
    <button onClick={onClick}
      className={
        'px-2 py-0.5 rounded border text-[11px] ' +
        (active
          ? 'bg-accent/20 text-accent border-accent/50'
          : 'bg-bg text-muted border-border hover:border-accent/50 hover:text-text')
      }>
      {label}
    </button>
  );
}

// IANA TZ picker. Options render as "<desc> (<label>)" so the dropdown
// is scannable -- "Hong Kong (HKG)" reads better than just "HKG".
// Underlying value is the IANA name (e.g. America/New_York); engine-
// side consumer must resolve via tzdata for DST correctness -- never
// assume EST/EDT from a label string. List sourced from
// tv-broker-relay's marketSessions.js.
function TzSelect({ value, onChange }) {
  const known = MARKET_SESSIONS.find(s => s.tz === value);
  const title = known ? `${known.desc} -- ${value}` : value;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={title}
      className="px-1 h-5 bg-bg border border-border rounded text-text text-[11px]"
    >
      {MARKET_SESSIONS.map(s => (
        <option key={s.tz} value={s.tz}>{s.desc} ({s.label})</option>
      ))}
    </select>
  );
}

function HhmmInput({ value, onChange }) {
  // Internal storage = packed HHMM int (e.g. 1530 = 15:30) to match
  // engine's SessionWindow struct. Display as HH:MM string.
  const display = (() => {
    const v = Number.isFinite(value) ? value : 0;
    const h = Math.floor(v / 100);
    const m = v % 100;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  })();
  return (
    <input
      type="time"
      value={display}
      step={60}
      onChange={(e) => {
        const [h, m] = e.target.value.split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) onChange(h * 100 + m);
      }}
      className="px-1.5 h-5 bg-bg border border-border rounded text-text text-[11px] tnum"
    />
  );
}
