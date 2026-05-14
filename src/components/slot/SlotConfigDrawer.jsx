// Slide-in drawer for editing a live slot's strategy config in place.
// Mirrors the playground's schema-driven editor (same ParamRow +
// SchemaSection components) but shows the runner's CURRENTLY-DEPLOYED
// values as the baseline + highlights every field the user has edited
// against that baseline. Apply pushes back to the runner via the
// per-slot reinit endpoint that engine-claude is shipping.
//
// Today the Apply path is stubbed (engine-side endpoint not landed
// yet -- devstream Stream L131/L132). Until then the drawer is
// read-only-with-an-edit-preview: you can scroll through the deployed
// config and see what the slot is actually running, edit values to
// see your intended diff, and the Apply button surfaces the engine
// dependency rather than silently no-op'ing.
//
// Shape-change fields (the 7 indicator-shape keys: fastPeriod,
// slowPeriod, atrPeriod, fast/slowMaType, fast/slowSource) used to
// require a runner restart but engine ad16711 made them hot-swappable
// via warmup-replay against a 500-bar ring. Still flagged with a soft
// stripe so the operator knows the apply path is heavier (~ms vs
// sub-ms) and that very-first-boot reinits before bars have closed
// will reject with a "wait ~5×period bars or restart" error.

import { useEffect, useMemo, useState } from 'react';
import ParamRow from '../schema/ParamRow';
import SchemaSection from '../schema/SchemaSection';
import { paramActive } from '../schema/schemaLabels';
import { fetchStrategySchema } from '../../data/strategySchema';
import {
  fetchSlotConfig,
  applySlotConfig,
  SHAPE_CHANGE_KEYS,
} from '../../data/slotConfigClient';
import { MARKET_SESSIONS, DEFAULT_MARKET_TZ } from '../../data/marketSessions';

const STRATEGY = 'xovd_v1';

// Meta / deployment fields that live IN the per-slot config row but
// are NOT in xovd_v1_schema.json's sections (which only cover strategy
// params). Pinned to the top of the drawer so users can see + edit
// the slot's identity at a glance. Layer 1 only -- relay/.env infra
// (Layer 2) and coord-registry rows (Layer 3) are out of scope per
// Niall direction.
const META_FIELDS = [
  { name: 'account',  label: 'Account',   type: 'string',
    tooltip: 'Broker account this slot trades against.' },
  { name: 'algoId',   label: 'Algo ID',   type: 'string',
    tooltip: 'Identifier the relay uses to route this slot\'s POSTs.' },
  { name: 'broker',   label: 'Broker',    type: 'enum', values: ['tradovate'],
    tooltip: 'Broker the relay forwards orders to.' },
  { name: 'symbol',   label: 'Symbol',    type: 'string',
    tooltip: 'Tradable symbol (e.g. MNQ1!).' },
  { name: 'live',     label: 'Live',      type: 'bool',
    tooltip: 'When false the slot runs dry -- no POSTs to the relay.' },
];
const META_KEYS = new Set(META_FIELDS.map(f => f.name));

// Mirror of xovdDefaultSessions() in backtester/runtime/sessionMask.h.
// Used as the fallback shape for legacy slot configs whose .jsonl
// rows pre-date the sessionMode/sessionTz/sessionWindows fields
// (engine ad16711 falls back to these same defaults when the keys
// are absent). Times interpreted in the section-level `sessionTz`.
const DEFAULT_SESSIONS = [
  { startHHMM: 630,  endHHMM: 1155, label: 'S1' },
  { startHHMM: 1205, endHHMM: 1530, label: 'S2' },
  { startHHMM: 1705, endHHMM: 155,  label: 'S3 (wraps midnight)' },
];

export default function SlotConfigDrawer({ runnerId, slotIdx, account, onClose }) {
  const [schema, setSchema]     = useState(null);
  const [baseline, setBaseline] = useState(null);   // immutable; runner's deployed values
  const [values, setValues]     = useState(null);   // editable; starts = baseline
  const [err, setErr]           = useState(null);
  const [busy, setBusy]         = useState(false);
  const [toast, setToast]       = useState(null);

  // Initial load: schema + slot config in parallel.
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    Promise.all([
      fetchStrategySchema(STRATEGY),
      fetchSlotConfig(runnerId, slotIdx),
    ]).then(([s, c]) => {
      if (cancelled) return;
      // Legacy slot configs may lack sessionMode/sessionTz/
      // sessionWindows. Engine treats absent keys as "use the
      // hardcoded xovdDefaultSessions" -- mirror that defaulting
      // into baseline so the editor doesn't immediately light up
      // dirty just because we filled in the displayed values.
      const cfg = { ...c.config };
      if (cfg.sessionMode    == null) cfg.sessionMode    = 'include';
      if (cfg.sessionTz      == null) cfg.sessionTz      = DEFAULT_MARKET_TZ;
      if (cfg.sessionWindows == null) cfg.sessionWindows = DEFAULT_SESSIONS;
      setSchema(s);
      setBaseline(cfg);
      setValues({ ...cfg });
    }).catch(e => {
      if (!cancelled) setErr(e.message || String(e));
    });
    return () => { cancelled = true; };
  }, [runnerId, slotIdx]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sections = useMemo(() => groupBySection(schema), [schema]);
  const dirtyKeys = useMemo(() => {
    if (!values || !baseline) return new Set();
    const out = new Set();
    for (const k of Object.keys(values)) {
      if (!shallowEq(values[k], baseline[k])) out.add(k);
    }
    return out;
  }, [values, baseline]);

  const onChange = (key, raw) => {
    // Coerce based on the schema's type for known params, or the
    // META_FIELDS entry's type for the pinned identity row.
    let type = schema?.params?.[key]?.type;
    if (!type) {
      const meta = META_FIELDS.find(f => f.name === key);
      type = meta?.type;
    }
    if (!type) return;
    const v = (type === 'int') ? parseInt(raw, 10)
            : (type === 'float') ? parseFloat(raw)
            : raw;
    setValues(prev => ({ ...prev, [key]: v }));
  };

  const reset = () => setValues({ ...baseline });

  const apply = async () => {
    setBusy(true);
    try {
      // Engine's reinit protocol wants the FULL XovdV1Config row, not
      // a patch. Spread baseline + the edited values for every dirty
      // key (sessionMode/sessionTz/sessionWindows now live in the
      // canonical schema slot, so no special-casing needed).
      const fullCfg = { ...baseline };
      for (const k of dirtyKeys) fullCfg[k] = values[k];
      const ack = await applySlotConfig(runnerId, slotIdx, fullCfg);
      if (ack.ok) {
        setToast({ ok: true, text: ack.shape_changed
          ? `Applied ${dirtyKeys.size} change(s) — indicators warmup-replayed`
          : `Applied ${dirtyKeys.size} change(s)` });
        // Promote the just-applied values to the new baseline so the
        // dirty-edit highlights clear.
        setBaseline({ ...baseline, ...Object.fromEntries(
          [...dirtyKeys].map(k => [k, values[k]])
        )});
      } else {
        // Engine error string is operator-readable -- pass through.
        // Common reject paths: unknown key (parse error), or shape-
        // change reinit before the bar ring is populated ("wait ~5x
        // period bars or restart").
        setToast({
          ok: false,
          text: `Apply failed: ${ack.error || 'unknown error'}`,
        });
      }
    } catch (e) {
      setToast({ ok: false, text: e.message || String(e) });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 6000);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex">
      {/* Click-outside backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />
      {/* Drawer */}
      <div className="w-[460px] bg-panel border-l border-border flex flex-col shadow-2xl">
        <Header runnerId={runnerId} slotIdx={slotIdx} account={account}
                dirty={dirtyKeys.size} onClose={onClose} />
        <div className="flex-1 overflow-y-auto">
          {err && (
            <div className="p-4 text-xs text-short">Failed to load: {err}</div>
          )}
          {!err && (!schema || !values) && (
            <div className="p-4 text-xs text-muted">loading…</div>
          )}
          {schema && values && (
            <SchemaSection id="slotcfg.meta" title="Slot identity"
                           badge={metaDirtyBadge(META_FIELDS, dirtyKeys)}
                           defaultOpen>
              {META_FIELDS.map(def => {
                const isDirty = dirtyKeys.has(def.name);
                return (
                  <RowFrame key={def.name} dirty={isDirty} restart={false}>
                    <ParamRow
                      schemaField={def}
                      value={values[def.name]}
                      onChange={v => onChange(def.name, v)}
                    />
                  </RowFrame>
                );
              })}
            </SchemaSection>
          )}
          {schema && values && (
            <SchemaSection id="slotcfg.session"
                           title="Trading hours"
                           badge={sessionDirtyBadge(dirtyKeys)}
                           defaultOpen={false}>
              <SessionWindowsEditor
                mode={values.sessionMode}
                tz={values.sessionTz}
                windows={values.sessionWindows}
                onChange={(m, t, w) => setValues(prev => ({
                  ...prev,
                  sessionMode: m,
                  sessionTz: t,
                  sessionWindows: w,
                }))}
              />
            </SchemaSection>
          )}
          {schema && values && (
            <SchemaSection id="slotcfg.webhook"
                           title="Webhook (runner-wide)"
                           badge="preview"
                           defaultOpen={false}>
              <WebhookConfigEditor />
            </SchemaSection>
          )}
          {schema && values && sections.map(sec => (
            <SchemaSection key={sec.id}
                           id={`slotcfg.${sec.id}`}
                           title={sec.title}
                           badge={dirtyCountForSection(sec, dirtyKeys)}
                           defaultOpen>
              {sec.fields.map(key => {
                const def = { ...schema.params[key], name: key };
                if (!def.type) return null;   // not in schema (deployment-only)
                const active = paramActive(def, values);
                const isDirty = dirtyKeys.has(key);
                const shapeChange = SHAPE_CHANGE_KEYS.has(key);
                return (
                  <RowFrame key={key} dirty={isDirty} shapeChange={shapeChange}>
                    <ParamRow
                      schemaField={def}
                      value={values[key]}
                      onChange={v => onChange(key, v)}
                      disabled={!active}
                    />
                  </RowFrame>
                );
              })}
            </SchemaSection>
          ))}
        </div>
        <Footer dirty={dirtyKeys.size} busy={busy}
                onApply={apply} onReset={reset} onClose={onClose}
                toast={toast} />
      </div>
    </div>
  );
}

function Header({ runnerId, slotIdx, account, dirty, onClose }) {
  return (
    <div className="px-3 py-2 border-b border-border bg-bg flex items-center gap-2">
      <span className="font-semibold text-sm">Slot {slotIdx} config</span>
      <span className="text-muted">·</span>
      <span className="text-xs">{account}</span>
      <span className="text-muted text-[10px] truncate flex-1">{runnerId}</span>
      {dirty > 0 && (
        <span className="px-1.5 py-px text-[10px] rounded bg-accent/20 text-accent border border-accent/40 tnum">
          {dirty} edited
        </span>
      )}
      <button onClick={onClose}
              className="text-muted hover:text-text text-lg leading-none ml-1">×</button>
    </div>
  );
}

function Footer({ dirty, busy, onApply, onReset, onClose, toast }) {
  const canApply = dirty > 0 && !busy;
  return (
    <div className="px-3 py-2 border-t border-border bg-bg flex items-center gap-2 relative">
      <button onClick={onReset} disabled={dirty === 0 || busy}
              className="px-2 py-1 rounded bg-bg border border-border text-muted hover:text-text disabled:opacity-30 text-[11px]">
        Reset
      </button>
      <button onClick={onClose}
              className="px-2 py-1 rounded bg-bg border border-border text-muted hover:text-text text-[11px]">
        Close
      </button>
      <div className="flex-1" />
      <button
        onClick={onApply}
        disabled={!canApply}
        title={dirty === 0
          ? 'No edits to apply'
          : 'Push changes to the runner (per-slot live reinit)'}
        className="px-3 py-1 rounded bg-accent text-bg font-semibold disabled:opacity-30 disabled:cursor-not-allowed text-[11px]">
        {busy ? 'Applying…' : `Apply${dirty > 0 ? ` (${dirty})` : ''}`}
      </button>
      {toast && (
        <div className={`absolute -top-2 right-3 -translate-y-full text-[11px] px-2 py-0.5 rounded shadow z-10 ${
          toast.ok ? 'bg-long/90 text-bg' : 'bg-short/90 text-bg'
        } max-w-[400px] truncate`} title={toast.text}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

// Wraps a ParamRow with a colored left-edge stripe so dirty edits +
// shape-change fields are visible at a glance. Shape-change uses a
// dim slate stripe (not the old amber) since these fields ARE hot-
// swappable now -- the stripe just signals "this triggers warmup-
// replay, not a same-shape reinit."
function RowFrame({ children, dirty, shapeChange }) {
  let stripe = 'border-l-2 border-transparent';
  if (dirty)            stripe = 'border-l-2 border-accent';
  else if (shapeChange) stripe = 'border-l-2 border-slate-500/40';
  return (
    <div className={stripe} title={shapeChange && !dirty
      ? 'Indicator-shape field — apply triggers warmup-replay (~ms cost)'
      : undefined}>
      {children}
    </div>
  );
}

// Walk schema.sections, keeping every key that has a schema definition.
// Unlike the playground we don't filter by `sweepable` -- the user
// editing a live slot wants to see EVERY tunable param the runner is
// using, not just the ones we'd sweep. Anything in schema.params but
// NOT placed in a section gets caught by an "Other" appendix at the
// bottom so no live-config field is invisible.
function groupBySection(schema) {
  if (!schema) return [];
  const out = [];
  const placed = new Set();
  for (const sec of (schema.sections || [])) {
    const fields = [];
    for (const row of (sec.rows || [])) {
      for (const col of (row.cols || [])) {
        const key = col.key;
        if (!key) continue;
        if (!schema.params[key]) continue;
        fields.push(key);
        placed.add(key);
      }
    }
    if (fields.length) out.push({ id: sec.id, title: sec.title, fields });
  }
  const orphans = Object.keys(schema.params || {}).filter(k => !placed.has(k));
  if (orphans.length) {
    out.push({ id: 'other', title: 'Other', fields: orphans.sort() });
  }
  return out;
}

function dirtyCountForSection(sec, dirtyKeys) {
  let n = 0;
  for (const k of sec.fields) if (dirtyKeys.has(k)) n++;
  return n > 0 ? `${sec.fields.length} · ${n} edited` : `${sec.fields.length}`;
}

function metaDirtyBadge(metaFields, dirtyKeys) {
  let n = 0;
  for (const f of metaFields) if (dirtyKeys.has(f.name)) n++;
  return n > 0 ? `${metaFields.length} · ${n} edited` : `${metaFields.length}`;
}

function shallowEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  // Arrays + objects (sessionWindows is an array of objects). String-
  // coerce would collapse to "[object Object]" and miss real edits.
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

const SESSION_KEYS = new Set(['sessionMode', 'sessionTz', 'sessionWindows']);
function sessionDirtyBadge(dirtyKeys) {
  let n = 0;
  for (const k of SESSION_KEYS) if (dirtyKeys.has(k)) n++;
  return n > 0 ? `${n} edited` : null;
}

// ──────────────────────────────────────────────────────────────────────
// Trading-hours editor
//
// Two modes:
//   'include' = trade ONLY inside the listed windows (current runner
//                default, three NY-time bands)
//   'exclude' = trade 24h EXCEPT the listed windows (matches the
//                xovdDefaultExclusions() alternative -- narrow blocks
//                around bad-window minutes Niall identified 2026-05-12)
//
// Wires the canonical sessionMode/sessionTz/sessionWindows keys
// engine ad16711 reads from per-slot cfg. Hot-swap path: Apply
// triggers a reinit; engine treats session changes as hot-swappable
// (next bar's mask reflects new config).
// ──────────────────────────────────────────────────────────────────────
function SessionWindowsEditor({ mode, tz, windows, onChange }) {
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
            {mode === 'include' ? 'No windows -- runner will not trade.' : 'No exclusions -- runner trades 24h.'}
          </div>
        )}
      </div>
      <button onClick={addWindow}
              className="mt-2 px-2 py-0.5 rounded bg-bg border border-border hover:border-accent text-muted hover:text-text text-[11px]">
        + Add window
      </button>
      <div className="mt-2 text-[10px] text-muted leading-relaxed">
        Hot-swappable -- Apply pushes via reinit and the next bar's
        mask reflects the new windows. TZ resolves via tzdata so DST
        flips correctly.
      </div>
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
// Once selected the picker collapses to the human description so the
// chosen value is still readable at a glance. Underlying value is the
// IANA name (e.g. America/New_York); engine-side consumer must resolve
// via tzdata for DST correctness -- never assume EST/EDT from a label
// string. List sourced from tv-broker-relay's marketSessions.js.
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

// ──────────────────────────────────────────────────────────────────────
// Webhook config (preview; runner-wide infra, not per-slot)
//
// The relay credentials live in runner/configs/.env on the VPS; all
// three slots share them. This section is read-only-preview today --
// coord doesn't yet have a GET /env/relay endpoint that returns the
// loaded config (Stream ask filed). When it lands the secret never
// comes over the wire literal; only a hash prefix so users can verify
// "yes, the slot's loaded relay key matches the relay UI's record."
// Edit path is deferred (NSSM bounce + careful credential handling).
// ──────────────────────────────────────────────────────────────────────
function WebhookConfigEditor() {
  return (
    <div className="px-2 py-2 text-[11px] space-y-2">
      <KvRow k="endpoint"   v="https://tvbrokerrelay.com" />
      <KvRow k="tenant id"  v="(loaded from runner/configs/.env)" muted />
      <KvRow k="api key"    v="(set; not displayed for safety)" muted />
      <KvRow k="dryrun"     v="(false in prod, true in shadow)" muted />
      <div className="text-[10px] text-muted leading-relaxed pt-1">
        Webhook config lives in runner-process .env so all three slots
        share it. Coord-mediated read (mask + sha8 of the secret so
        you can spot-check it matches the relay UI) is the next step;
        edit path deferred since changing the secret needs a runner
        restart and warrants its own confirmation flow.
      </div>
    </div>
  );
}

function KvRow({ k, v, muted }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted shrink-0 w-[80px] text-[10px] uppercase tracking-wide">{k}</span>
      <span className={muted ? 'text-muted' : 'text-text font-semibold'}>{v}</span>
    </div>
  );
}
