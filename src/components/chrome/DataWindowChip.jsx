// Header chip + popover + Builder dialog for data windows.
//
// Lives in NavRow2Lab between the Playground/Sweeps tabs (per Niall
// direction). Click opens the popover with:
//   - rows for each existing window (active marker, delete button)
//   - an in-flight build's progress (when one is running)
//   - "+ New window" affordance -> opens the Builder dialog
//
// Builder dialog: from-date + to-date + symbol (MNQ.c.0 today, list
// expands when more symbols land). Live pre-flight estimate updates
// as dates change. Build submits via POST and the popover swaps to a
// progress view (chunk N/total + a thin bar).
//
// Coord-side: data-windows feature gates on cfg.data_windows_dir.
// VPS coord doesn't set it -> /api/data-windows 503s. The chip
// hides itself in that case so it doesn't surface a broken affordance
// when the user's on a coord that doesn't host the feature.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDataWindow, deleteDataWindow, listDataWindows,
  openBuildEvents, preflightDataWindow, setActiveDataWindow,
} from '../../data/dataWindowsClient';

// What's actually in the local DBN archive today (per-day mbp1
// captures of the front-month contract). MNQ.c.0 / ES.c.0 etc. are
// a different subscription/schema (continuous-front-month) -- when
// those land in their own archive they get their own picker entries.
// Future: drive this list from a coord endpoint (`GET /api/data-
// windows/symbols`) that scans the archive's symbology union.
const SYMBOLS = ['MNQM6', 'NQM6', 'MESM6', 'ESM6'];

export default function DataWindowChip() {
  const [snapshot, setSnapshot]   = useState(null);  // {windows, active_id, building}
  const [loadErr, setLoadErr]     = useState(null);
  const [popOpen, setPopOpen]     = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [busy, setBusy]           = useState(false);
  const [activeBuildJobId, setActiveBuildJobId] = useState(null);
  const [activeBuildState, setActiveBuildState] = useState(null);  // {n, m, line?}
  const popRef = useRef(null);
  const chipRef = useRef(null);

  const refresh = async () => {
    try {
      const s = await listDataWindows();
      setSnapshot(s);
      setLoadErr(null);
      // If a build was already running coord-side when we mounted,
      // resume listening to its events so the chip stays live across
      // reloads / tab switches.
      if (s.building?.job_id && !activeBuildJobId) {
        setActiveBuildJobId(s.building.job_id);
      }
    } catch (e) {
      setLoadErr(e.message || String(e));
      setSnapshot(null);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Re-fetch when the popover opens (catch coord-side changes other
  // tabs may have made).
  useEffect(() => { if (popOpen) refresh(); }, [popOpen]);

  // Click-outside-to-close the popover. Listen on capture so we beat
  // any click handlers inside the popover that .stopPropagation().
  useEffect(() => {
    if (!popOpen) return;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (chipRef.current?.contains(e.target)) return;
      setPopOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [popOpen]);

  // Live build SSE -- progress + done.
  useEffect(() => {
    if (!activeBuildJobId) return;
    const es = openBuildEvents(activeBuildJobId, ({ type, data }) => {
      if (type === 'hello' || type === 'progress') {
        setActiveBuildState({
          n: data?.n ?? data?.n_chunks_done ?? 0,
          m: data?.m ?? data?.n_chunks_total ?? 0,
        });
      } else if (type === 'done') {
        setActiveBuildState({
          n: data?.n_chunks_done ?? 0,
          m: data?.n_chunks_total ?? 0,
          state: data?.state,
          error: data?.error,
        });
        setActiveBuildJobId(null);
        // New window auto-selects: refresh + try to set it active.
        refresh().then(() => {
          if (data?.state === 'done' && data?.window_id) {
            setActiveDataWindow(data.window_id).then(refresh).catch(() => {});
          }
        });
      }
    });
    return () => es.close();
  }, [activeBuildJobId]);

  // When the active 'sweep' coord doesn't host data-windows
  // (e.g. the user's sweep scope is pointed at the VPS coord),
  // surface that explicitly rather than hiding the chip -- a
  // hidden chip is a confusing user experience.
  const featureMissing = loadErr?.includes('503');

  const active = snapshot?.windows?.find(w => w.id === snapshot.active_id);
  const label = featureMissing ? 'no data-windows on this coord'
              : loadErr        ? 'unreachable'
              : active         ? fmtRange(active.from, active.to)
              : snapshot?.windows?.length ? 'Pick a window'
              : snapshot       ? 'Build a window'
              :                  'loading…';
  const disabled = featureMissing || (!snapshot && !loadErr);

  return (
    <div className="relative ml-3">
      <button
        ref={chipRef}
        disabled={disabled}
        onClick={() => setPopOpen(o => !o)}
        title={loadErr ? `Data windows: ${loadErr}` : 'Pick or build a data window'}
        className={
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded ' +
          'border text-[11px] tnum ' +
          (loadErr
            ? 'border-short text-short bg-short/10'
            : 'border-border text-muted hover:text-text hover:border-accent')
        }
      >
        <span className="text-[9px] uppercase tracking-wide opacity-60">Timeframe</span>
        <span className="text-text">{label}</span>
        {activeBuildJobId && activeBuildState && (
          <span className="ml-2 text-accent text-[10px]">
            building {activeBuildState.n}/{activeBuildState.m || '?'}
          </span>
        )}
        <span className="opacity-60">▾</span>
      </button>
      {popOpen && (
        <div ref={popRef}
             className="absolute top-full left-0 mt-1 z-30 w-[420px] rounded shadow-xl
                        bg-panel border border-border text-[11px]">
          <Popover
            snapshot={snapshot}
            activeBuildJobId={activeBuildJobId}
            activeBuildState={activeBuildState}
            busy={busy}
            onActivate={async (wid) => {
              try {
                setBusy(true);
                await setActiveDataWindow(wid);
                await refresh();
              } finally { setBusy(false); }
            }}
            onDelete={async (wid) => {
              if (!confirm(`Delete window ${wid}? bar.bin + tick.bin gone.`)) return;
              try {
                setBusy(true);
                await deleteDataWindow(wid);
                await refresh();
              } finally { setBusy(false); }
            }}
            onNew={() => { setBuilderOpen(true); }}
          />
        </div>
      )}
      {builderOpen && (
        <BuilderDialog
          onClose={() => setBuilderOpen(false)}
          onSubmit={async ({ symbol, frm, to }) => {
            const { job_id } = await buildDataWindow({ symbol, frm, to });
            setActiveBuildJobId(job_id);
            setActiveBuildState({ n: 0, m: 0 });
            setBuilderOpen(false);
            setPopOpen(true);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// ── Popover body ─────────────────────────────────────────────────────

function Popover({ snapshot, activeBuildJobId, activeBuildState, busy,
                   onActivate, onDelete, onNew }) {
  if (!snapshot) {
    return <div className="p-3 text-muted">loading…</div>;
  }
  const { windows = [], active_id } = snapshot;
  return (
    <div>
      <div className="px-3 py-2 flex items-baseline justify-between border-b border-border">
        <span className="text-[10px] uppercase tracking-wide text-muted">Data windows</span>
        <span className="text-[10px] text-muted">{windows.length}</span>
      </div>
      {activeBuildJobId && activeBuildState && (
        <BuildProgress state={activeBuildState} />
      )}
      <div className="max-h-[280px] overflow-y-auto">
        {windows.length === 0 && (
          <div className="px-3 py-3 text-muted italic">
            no windows yet — click "+ New window" to build one
          </div>
        )}
        {windows.map(w => (
          <WindowRow
            key={w.id}
            w={w}
            active={w.id === active_id}
            disabled={busy}
            onActivate={() => onActivate(w.id)}
            onDelete={() => onDelete(w.id)}
          />
        ))}
      </div>
      <div className="px-3 py-2 border-t border-border">
        <button
          onClick={onNew}
          className="w-full px-2 py-1 rounded bg-accent/20 hover:bg-accent/30
                     text-accent border border-accent/30 hover:border-accent
                     text-[11px] font-semibold"
        >
          + New window
        </button>
      </div>
    </div>
  );
}

function WindowRow({ w, active, disabled, onActivate, onDelete }) {
  return (
    <div className={'flex items-center gap-2 px-3 py-1.5 border-b border-border/30 ' +
                    (active ? 'bg-accent/10' : 'hover:bg-bg/40')}>
      <span className={'shrink-0 w-3 text-center ' + (active ? 'text-accent' : 'text-muted/40')}>
        {active ? '●' : '○'}
      </span>
      <button
        onClick={onActivate}
        disabled={disabled || active}
        className="flex-1 text-left disabled:cursor-default tnum"
        title={`Activate ${w.id}`}
      >
        <div className="text-text">{fmtRange(w.from, w.to)}</div>
        <div className="text-[10px] text-muted">
          {w.symbol} · {fmtBytes(w.bar_bytes)} bars + {fmtBytes(w.tick_bytes)} ticks
        </div>
      </button>
      <button
        onClick={onDelete}
        disabled={disabled}
        title="Delete window"
        className="text-muted hover:text-short text-sm leading-none px-1"
      >
        ×
      </button>
    </div>
  );
}

function BuildProgress({ state }) {
  const pct = state.m > 0 ? Math.min(100, (state.n / state.m) * 100) : 0;
  const final = state.state === 'done' || state.state === 'error' || state.state === 'cancelled';
  return (
    <div className="px-3 py-2 border-b border-border bg-bg/40">
      <div className="flex items-baseline justify-between text-[10px] text-muted mb-1">
        <span>Building</span>
        <span className="tnum">
          {state.n}/{state.m || '?'} chunks
          {final && state.state !== 'done' && (
            <span className="text-short ml-2">{state.state}{state.error ? `: ${state.error}` : ''}</span>
          )}
          {final && state.state === 'done' && <span className="text-long ml-2">done</span>}
        </span>
      </div>
      <div className="h-1.5 bg-bg rounded overflow-hidden">
        <div className={'h-full ' + (state.state === 'error' ? 'bg-short' : 'bg-accent')}
             style={{ width: `${pct}%`, transition: 'width 0.2s linear' }} />
      </div>
    </div>
  );
}

// ── Builder dialog ───────────────────────────────────────────────────

function BuilderDialog({ onClose, onSubmit }) {
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  // Default range: last 30 days, today exclusive.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defaultFrm = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }, []);
  const [frm, setFrm] = useState(defaultFrm);
  const [to, setTo]   = useState(today);
  const [estimate, setEstimate] = useState(null);
  const [estErr, setEstErr]     = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr]   = useState(null);

  // Live pre-flight as dates change. Debounce so dragging the date
  // picker doesn't fire a flurry of requests.
  useEffect(() => {
    let cancelled = false;
    setEstErr(null);
    const t = setTimeout(() => {
      preflightDataWindow(frm, to)
        .then(e => { if (!cancelled) setEstimate(e); })
        .catch(e => { if (!cancelled) { setEstimate(null); setEstErr(e.message || String(e)); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [frm, to]);

  const onSubmitClick = async () => {
    setSubmitErr(null);
    setSubmitting(true);
    try {
      await onSubmit({ symbol, frm, to });
    } catch (e) {
      setSubmitErr(e.message || String(e));
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center"
         onClick={onClose}>
      <div className="bg-panel border border-border rounded shadow-2xl p-4 w-[440px]"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold">New data window</h3>
          <button onClick={onClose} className="text-muted hover:text-text leading-none">×</button>
        </div>
        <div className="space-y-2 text-[11px] tnum">
          <KvRow label="symbol">
            <select value={symbol} onChange={e => setSymbol(e.target.value)}
                    className="bg-bg border border-border rounded px-1 py-0.5">
              {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </KvRow>
          <KvRow label="from">
            <input type="date" value={frm} max={to}
                   onChange={e => setFrm(e.target.value)}
                   className="bg-bg border border-border rounded px-1 py-0.5" />
          </KvRow>
          <KvRow label="to">
            <input type="date" value={to} min={frm} max={today}
                   onChange={e => setTo(e.target.value)}
                   className="bg-bg border border-border rounded px-1 py-0.5" />
          </KvRow>
        </div>
        <div className="mt-3 px-2 py-2 bg-bg/50 rounded text-[10px] text-muted leading-relaxed">
          {estErr && <span className="text-short">{estErr}</span>}
          {!estErr && estimate && (
            <>
              <div>
                Span: <span className="text-text">{estimate.span_days} days</span>
                {' · '}
                Chunks: <span className="text-text tnum">{estimate.est_chunks}</span>
              </div>
              <div>
                Source: <span className="text-text">~{fmtBytes(estimate.est_dbn_bytes)}</span>
                {' DBN → '}
                <span className="text-text">~{fmtBytes(estimate.est_tick_bytes)} ticks</span>
                {' + '}
                <span className="text-text">~{fmtBytes(estimate.est_bar_bytes)} bars</span>
              </div>
              <div>
                Build time: <span className="text-text tnum">{fmtSeconds(estimate.est_decode_seconds)}</span>
                <span className="opacity-60"> (rough; per-day calibration)</span>
              </div>
            </>
          )}
        </div>
        {submitErr && (
          <div className="mt-2 text-[11px] text-short">{submitErr}</div>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button onClick={onClose}
                  disabled={submitting}
                  className="px-3 py-1 rounded bg-bg border border-border text-muted hover:text-text text-[11px]">
            Cancel
          </button>
          <button onClick={onSubmitClick}
                  disabled={submitting || !!estErr}
                  className="px-3 py-1 rounded bg-accent text-bg font-semibold disabled:opacity-30 text-[11px]">
            {submitting ? 'Submitting…' : 'Build'}
          </button>
        </div>
      </div>
    </div>
  );
}

function KvRow({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-muted">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ── Formatters ───────────────────────────────────────────────────────

function fmtRange(frm, to) {
  // 2022-01-01 -> 2022.01.01 (compact, matches Niall's preferred shape)
  const fmt = (s) => s.replace(/-/g, '.');
  return `${fmt(frm)}–${fmt(to)}`;
}

function fmtBytes(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'KB';
  return `${n}B`;
}

function fmtSeconds(s) {
  if (!s) return '~0s';
  if (s >= 3600) return `~${(s / 3600).toFixed(1)}h`;
  if (s >= 60)   return `~${(s / 60).toFixed(0)}m`;
  return `~${s}s`;
}
