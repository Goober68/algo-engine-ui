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
import SessionWindowsEditor, { DEFAULT_SESSIONS } from './SessionWindowsEditor';

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

// (DEFAULT_SESSIONS sourced from ./SessionWindowsEditor.jsx so the
//  three consumers -- live config, playground, sweep -- agree on the
//  fallback shape engine ad16711 also defaults to.)

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
                footnote={
                  "Hot-swappable -- Apply pushes via reinit and the next "
                  + "bar's mask reflects the new windows. TZ resolves via "
                  + "tzdata so DST flips correctly."
                }
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
// (Trading-hours editor lives in ./SessionWindowsEditor.jsx; same
//  control reused by SlotConfigDrawer / LabPlayground / LabSweeps.)

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
