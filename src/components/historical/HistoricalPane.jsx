// Self-contained per-pane container for the Historical tabs (SxS and
// Single). Owns its own loaded-viz state; reuses SlotView's component
// stack (ChartPane, TradeTable, TradeTickModal) over a data shape
// produced by HistoricalDataProvider.buildHistoricalData.
//
// Props the parent route can wire:
//   label         — short id for splitter/persistence keys (e.g. 'A', 'B', 'S')
//   tf / setTf    — bar-period selector lifted to parent so panes can share it
//   onChartReady  — fires once the lightweight-charts instance is mounted,
//                   used by the SxS route for visible-range sync
//
// Everything else (file picker, drop zone, swap dropdown, trade table,
// tick modal) lives inside this component.

import { useEffect, useMemo, useRef, useState } from 'react';
import ChartPane from '../slot/ChartPane';
import TradeTable from '../slot/TradeTable';
import TradeTickModal from '../slot/TradeTickModal';
import Splitter from '../chrome/Splitter';
import { usePersistedSize } from '../chrome/usePersistedSize';
import { buildHistoricalData } from '../../data/HistoricalDataProvider';
import { useActiveCoord } from '../../data/coords';

export default function HistoricalPane({ label, tf, setTf, onChartReady }) {
  const coord = useActiveCoord('historical');
  const coordUrl = coord?.url || '';
  const [pane, setPane]                         = useState(null);
  const [filter, setFilter]                     = useState('all');
  const [selectedTradeKey, setSelectedTradeKey] = useState(null);
  const [modalTradeKey, setModalTradeKey]       = useState(null);
  const [railPx, setRailPx]                     = usePersistedSize(`historical.railPx.${label}`, 340);
  const [dragOver, setDragOver]                 = useState(false);

  const loadVizFile = async (file) => {
    try {
      const built = buildHistoricalData(await file.text(), label, { viz: file.name });
      setPane(built);
    } catch (e) { console.error('loadVizFile failed', e); }
  };

  const pickServerFile = async (name) => {
    try {
      const r = await fetch(`${coordUrl}/historical-files/${encodeURIComponent(name)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${name}`);
      const blob = await r.blob();
      await loadVizFile(new File([blob], name, { type: 'application/json' }));
    } catch (e) { console.error('pickServerFile failed', e); }
  };

  if (!pane) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <DropZone label={label} onLoaded={setPane} />
      </div>
    );
  }

  const onPaneDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!(name.endsWith('.viz.json') || name.endsWith('.json'))) return;
    await loadVizFile(f);
  };

  return (
    <div
      className={'flex-1 min-w-0 min-h-0 flex flex-col ' +
                 (dragOver ? 'ring-2 ring-accent ring-inset' : '')}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragOver={(e)  => { e.preventDefault(); }}
      onDragLeave={()  => setDragOver(false)}
      onDrop={onPaneDrop}
    >
      <PaneHeaderBar
        pane={pane}
        label={label}
        onReset={() => setPane(null)}
        onPickServerFile={pickServerFile}
      />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 relative">
          <ChartPane
            data={pane.data}
            runnerId={`historical-${label}`}
            tf={tf}
            setTf={setTf}
            selectedTradeKey={selectedTradeKey}
            setSelectedTradeKey={(k) => { setSelectedTradeKey(k); setModalTradeKey(k); }}
            onChartReady={onChartReady}
          />
        </div>
        <Splitter dir="col" size={railPx} setSize={setRailPx} min={220} max={700} invert />
        <div className="flex flex-col min-h-0 bg-panel" style={{ width: railPx }}>
          <TradeTable
            data={pane.data}
            filter={filter}
            setFilter={setFilter}
            selectedTradeKey={selectedTradeKey}
            setSelectedTradeKey={(k) => { setSelectedTradeKey(k); setModalTradeKey(k); }}
          />
        </div>
      </div>
      {modalTradeKey != null && (
        <TickModalWrapper
          data={pane.data}
          modalTradeKey={modalTradeKey}
          onClose={() => setModalTradeKey(null)}
          onJump={(k) => setModalTradeKey(k)}
        />
      )}
    </div>
  );
}

// ── Per-pane header ─────────────────────────────────────────────────
function PaneHeaderBar({ pane, label, onReset, onPickServerFile }) {
  const vizName = pane.fileNames?.viz || '(no viz)';
  const stats = useMemo(() => computeHeaderStats(pane.data), [pane.data]);
  return (
    <div className="flex items-stretch bg-panel border-b border-border px-3 py-1 text-xs tnum">
      <div className="flex items-center text-[11px] font-semibold text-accent mr-3">
        Pane {label}
      </div>
      <div className="flex items-baseline gap-2 min-w-0">
        <SwapMenu activeName={vizName} onPick={onPickServerFile} />
      </div>
      <div className="flex items-center gap-3 ml-auto">
        <Cell label="trades" v={stats.n} />
        <Cell label="WR"     v={`${stats.wr}%`} />
        <Cell label="PF"     v={stats.pf} />
        <Cell label="net"    v={fmtUSD(stats.net)} cls={cls(stats.net)} />
        <Cell label="DD"     v={fmtUSD(stats.dd)}  cls="text-short" />
      </div>
      <button
        onClick={onReset}
        title="Clear this pane"
        className="ml-3 px-2 text-muted hover:text-text"
      >
        ✕
      </button>
    </div>
  );
}

// ── Swap dropdown: server-side file list on click ───────────────────
function SwapMenu({ activeName, onPick }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState(null);
  const rootRef = useRef(null);
  const coord = useActiveCoord('historical');
  const coordUrl = coord?.url || '';

  useEffect(() => {
    if (!open) return;
    if (!listing) {
      fetch(`${coordUrl}/historical-files`)
        .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
        .then(setListing)
        .catch(e => setListing({ entries: [], error: String(e) }));
    }
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = (listing?.entries || []).filter(e => {
    const n = e.name.toLowerCase();
    return n.endsWith('.viz.json') || (n.endsWith('.json') && !n.endsWith('.events.json'));
  });

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="font-bold text-sm text-text truncate max-w-[400px] hover:text-accent text-left"
        title={`Click to swap viz file. Current: ${activeName}`}
      >
        {activeName}<span className="text-muted ml-1">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 top-full left-0 mt-1 w-[440px] bg-panel border border-border rounded shadow-lg">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted border-b border-border">
            Swap viz from server
            {listing?.dir && <span className="float-right truncate max-w-[280px]" title={listing.dir}>{listing.dir}</span>}
          </div>
          {!listing && <div className="p-3 text-xs text-muted">loading…</div>}
          {listing?.error && <div className="p-3 text-xs text-short">{listing.error}</div>}
          {listing && filtered.length === 0 && !listing.error && (
            <div className="p-3 text-xs text-muted italic">no .viz.json files in dir</div>
          )}
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody>
                {filtered.map(e => {
                  const active = e.name === activeName;
                  return (
                    <tr
                      key={e.name}
                      onClick={() => { onPick(e.name); setOpen(false); }}
                      className={`cursor-pointer hover:bg-accent/10 ${active ? 'bg-accent/15' : ''}`}
                    >
                      <td className="px-2 py-1 truncate max-w-[320px]" title={e.name}>
                        <code className={active ? 'text-accent' : 'text-text'}>{e.name}</code>
                      </td>
                      <td className="px-2 py-1 text-right text-muted tnum">{fmtKB(e.size)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Drop zone (shown only when pane is empty) ───────────────────────
function DropZone({ label, onLoaded }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError]       = useState(null);
  const [loading, setLoading]   = useState(false);
  const [serverFiles, setServerFiles] = useState(null);
  const vizInputRef = useRef(null);
  const coord = useActiveCoord('historical');
  const coordUrl = coord?.url || '';

  useEffect(() => {
    let cancelled = false;
    fetch(`${coordUrl}/historical-files`)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => { if (!cancelled) setServerFiles(d); })
      .catch(e => { if (!cancelled) setServerFiles({ entries: [], error: String(e) }); });
    return () => { cancelled = true; };
  }, [coordUrl]);

  const loadFile = async (file) => {
    setLoading(true);
    setError(null);
    try {
      const built = buildHistoricalData(await file.text(), label, { viz: file.name });
      onLoaded(built);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const pickFromServer = async (name) => {
    try {
      setLoading(true);
      const r = await fetch(`${coordUrl}/historical-files/${encodeURIComponent(name)}`);
      if (!r.ok) throw new Error(`fetch ${name}: HTTP ${r.status}`);
      const blob = await r.blob();
      await loadFile(new File([blob], name, { type: 'application/json' }));
    } catch (e) {
      setError(e.message || String(e));
      setLoading(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const n = f.name.toLowerCase();
    if (!(n.endsWith('.viz.json') || n.endsWith('.json'))) {
      setError(`expected a .viz.json, got ${f.name}`);
      return;
    }
    loadFile(f);
  };

  const vizEntries = (serverFiles?.entries || []).filter(e => {
    const n = e.name.toLowerCase();
    return n.endsWith('.viz.json') || (n.endsWith('.json') && !n.endsWith('.events.json'));
  });
  const haveServerFiles = vizEntries.length > 0;

  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
      onDragOver={(e)  => { e.preventDefault(); }}
      onDragLeave={()  => setDragging(false)}
      onDrop={onDrop}
      className={'w-[520px] p-6 rounded border-2 border-dashed text-center transition-colors ' +
                 (dragging ? 'border-accent bg-accent/5' : 'border-border bg-panel')}
    >
      <div className="text-text font-semibold text-sm mb-1">Pane {label}</div>
      {serverFiles?.dir && (
        <div className="text-[10px] text-muted mb-3 truncate" title={serverFiles.dir}>
          server: {serverFiles.dir}
        </div>
      )}
      {haveServerFiles && (
        <div className="mb-4 text-left">
          <div className="text-muted text-[11px] uppercase tracking-wide mb-1">Pick from server</div>
          <div className="max-h-72 overflow-y-auto rounded border border-border bg-bg">
            <table className="w-full text-xs">
              <tbody>
                {vizEntries.map(e => (
                  <tr
                    key={e.name}
                    onClick={() => pickFromServer(e.name)}
                    className="cursor-pointer hover:bg-accent/10"
                  >
                    <td className="px-2 py-1 truncate max-w-[320px]" title={e.name}>
                      <code className="text-text">{e.name}</code>
                    </td>
                    <td className="px-2 py-1 text-right text-muted tnum">{fmtKB(e.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!haveServerFiles && serverFiles?.error && (
        <div className="mb-3 text-short text-[11px]">
          server listing failed: {serverFiles.error}
        </div>
      )}
      <div className="text-muted text-xs leading-relaxed mb-3">
        Or drop a <code className="text-text">.viz.json</code> here.
      </div>
      <div className="flex flex-col gap-2 items-center text-xs">
        <button
          onClick={() => vizInputRef.current?.click()}
          className="px-3 py-1 bg-bg border border-border hover:border-accent rounded text-text"
        >
          Pick local .viz.json…
        </button>
        <input
          ref={vizInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); }}
        />
      </div>
      {loading && <div className="mt-3 text-muted text-xs">loading…</div>}
      {error && <div className="mt-3 text-short text-xs">{error}</div>}
    </div>
  );
}

// ── Tick modal wrapper ──────────────────────────────────────────────
function TickModalWrapper({ data, modalTradeKey, onClose, onJump }) {
  const trade = data.broker.find(t => t.entry_ts === modalTradeKey);
  if (!trade) { onClose(); return null; }
  const TF = 180;
  const entrySec = Math.floor(trade.entry_ts / 1e9);
  const barSec   = Math.floor(entrySec / TF) * TF;
  const decision = data.decisions?.find(d =>
    Math.floor(d.ts_ns / 1e9 / TF) * TF === barSec);
  const sorted = [...data.broker].sort((a, b) => a.entry_ts - b.entry_ts);
  const idx = sorted.findIndex(t => t.entry_ts === modalTradeKey);
  const prev = idx > 0                  ? sorted[idx - 1] : null;
  const next = idx < sorted.length - 1  ? sorted[idx + 1] : null;
  return (
    <TradeTickModal
      trade={trade}
      decision={decision}
      audit={null}
      onClose={onClose}
      onPrev={prev ? () => onJump(prev.entry_ts) : null}
      onNext={next ? () => onJump(next.entry_ts) : null}
    />
  );
}

// ── small helpers ───────────────────────────────────────────────────
function Cell({ label, v, cls = '' }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-muted text-[10px] uppercase tracking-wide">{label}</span>
      <span className={`font-semibold ${cls}`}>{v}</span>
    </span>
  );
}
function computeHeaderStats({ broker = [] } = {}) {
  const n = broker.length;
  const wins = broker.filter(t => t.pnl > 0).length;
  const gw   = broker.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl   = broker.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const pf   = gl < 0 ? (gw / -gl).toFixed(2) : '∞';
  const wr   = n ? Math.round((wins / n) * 100) : 0;
  const net  = broker.reduce((s, t) => s + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of broker) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return { n, wr, pf, net, dd };
}
function fmtUSD(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(0);
}
function cls(v) {
  if (v == null) return '';
  return v > 0 ? 'text-long' : v < 0 ? 'text-short' : '';
}
function fmtKB(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
