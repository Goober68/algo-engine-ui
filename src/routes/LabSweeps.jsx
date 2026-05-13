// Sweep Definition UI. Schema-driven recipe builder: render the full
// xovd_v1 schema grouped by category (entry/filter/exit/risk/lifecycle)
// → sections (collapsible) → rows of SweepRow controls. Footer shows
// total cartesian product + per-section badges.
//
// Submit POSTs to coord's /api/sweeps with the recipe + per-deploy
// paths (binary/bars/ticks/indicators) sourced from VITE_SWEEP_DEFAULTS.
// Live progress arrives over SSE; cancel issues a DELETE.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchStrategySchema } from '../data/strategySchema';
import SchemaSection from '../components/schema/SchemaSection';
import SweepRow from '../components/schema/SweepRow';
import {
  configCountForSection, initialRecipe, toSubmitPayload, totalConfigs,
} from '../components/schema/sweepRecipe';
import {
  cancelSweep, fetchResults, listSweeps, openSweepEvents, submitSweep,
} from '../data/sweepClient';

const STRATEGY = 'xovd_v1';

// Universal categories (per schema's section.category). Order matters
// for display. Lifecycle is collapsed by default.
const CATEGORY_ORDER = ['entry', 'filter', 'exit', 'risk', 'lifecycle'];
const CATEGORY_LABEL = {
  entry:     'Entry',
  filter:    'Filters',
  exit:      'Exits',
  risk:      'Risk management',
  lifecycle: 'Lifecycle',
};

export default function LabSweeps() {
  const [schema, setSchema]   = useState(null);
  const [error, setError]     = useState(null);
  const [recipe, setRecipe]   = useState(null);
  const [job, setJob]         = useState(null);     // {sweep_id, meta, progress[], events[]}
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [lastSweepId, setLastSweepId] = useState(null);   // most-recent COMPLETED sweep
  const [drawerOpen, setDrawerOpen]   = useState(false);  // recipe JSON drawer visibility
  const esRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetchStrategySchema(STRATEGY)
      .then(s => {
        if (cancelled) return;
        setSchema(s);
        setRecipe(initialRecipe(s));
      })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Cleanly close the SSE stream on unmount.
  useEffect(() => () => { esRef.current?.close(); esRef.current = null; }, []);

  // On mount: pick the most-recent completed sweep so users walking
  // back into the tab immediately see their last results.
  useEffect(() => {
    let cancelled = false;
    listSweeps()
      .then(d => {
        if (cancelled) return;
        const done = (d.sweeps || []).filter(s => s.state === 'done')
          .sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
        if (done[0]) setLastSweepId(done[0].sweep_id);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const grouped = useMemo(() => groupByCategory(schema), [schema]);
  const total   = useMemo(
    () => (schema && recipe) ? totalConfigs(schema, recipe) : 0,
    [schema, recipe]
  );

  if (error) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-short">
        Failed to load schema: {error}
      </div>
    );
  }
  if (!schema || !recipe) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-muted">
        loading schema…
      </div>
    );
  }

  const setRow = (name, next) => setRecipe(r => ({ ...r, [name]: next }));

  async function onSubmit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const payload = toSubmitPayload(STRATEGY, schema, recipe);
      const resp = await submitSweep(payload);
      const initial = {
        sweep_id: resp.sweep_id,
        meta:     resp,
        progress: [],
        stderr:   [],
      };
      setJob(initial);
      // Open the SSE stream for live progress.
      esRef.current?.close();
      esRef.current = openSweepEvents(resp.sweep_id, ({ type, data }) => {
        if (type === 'hello') {
          setJob(j => j && ({ ...j, meta: { ...j.meta, ...data?.meta },
                                       progress: data?.progress || j.progress }));
        } else if (type === 'progress') {
          setJob(j => j && ({ ...j, progress: [...j.progress, data] }));
        } else if (type === 'stderr') {
          setJob(j => j && ({ ...j, stderr: [...j.stderr, data] }));
        } else if (type === 'done') {
          setJob(j => j && ({ ...j, meta: { ...j.meta, state: data?.state || 'done',
                                                       exit_code: data?.exit_code } }));
          // Pin the last-completed sweep so SweepResults can fetch it
          // even after the job-status panel is dismissed.
          setLastSweepId(resp.sweep_id);
          esRef.current?.close();
          esRef.current = null;
        }
      });
    } catch (e) {
      setSubmitError(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancel() {
    if (!job?.sweep_id) return;
    try { await cancelSweep(job.sweep_id); } catch {}
    esRef.current?.close();
    esRef.current = null;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <Toolbar
        schema={schema} recipe={recipe} total={total}
        job={job} submitting={submitting}
        onSubmit={onSubmit} onCancel={onCancel}
        submitError={submitError}
        drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen(v => !v)}
      />
      <div className="flex-1 min-h-0 flex">
        {/* Recipe form (left) — width-capped so results panel gets the room */}
        <div className="w-[640px] shrink-0 min-h-0 overflow-y-auto bg-panel border-r border-border">
          {CATEGORY_ORDER.filter(c => grouped[c]?.length).map(cat => (
            <CategoryBlock
              key={cat}
              cat={cat}
              sections={grouped[cat]}
              schema={schema}
              recipe={recipe}
              onRowChange={setRow}
            />
          ))}
        </div>
        {/* Right pane — fills remaining width. Job status while running,
            then results from the most-recent completed sweep. */}
        <div className="flex-1 min-h-0 flex flex-col">
          {job && (job.meta?.state === 'starting' || job.meta?.state === 'running')
            ? <JobStatus job={job} onCancel={onCancel} />
            : <SweepResults sweepId={lastSweepId} job={job} />}
        </div>
      </div>
      {/* Sticky bottom-right dimensionality. */}
      <BottomDimBadge total={total} />
      {/* Recipe JSON drawer (toggle via toolbar button). */}
      {drawerOpen && (
        <RecipeDrawer
          schema={schema} recipe={recipe} total={total}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}

// Sticky bottom-right bubble showing total config count. Sits inside
// the form column so it doesn't overlap the results table.
function BottomDimBadge({ total }) {
  const tooBig = total > 10_000_000;
  const empty  = total < 1;
  return (
    <div className="absolute bottom-2 left-[520px] pointer-events-none">
      <div className="bg-bg/85 backdrop-blur-sm border border-border rounded px-2 py-1 text-[11px] tnum shadow-lg">
        <span className="text-muted">total </span>
        <span className={
          empty   ? 'text-short font-bold' :
          tooBig  ? 'text-short font-bold' :
          total > 1_000_000 ? 'text-accent font-bold' :
                              'text-text font-semibold'
        }>{fmtCount(total)}</span>
      </div>
    </div>
  );
}

// Group sections by category. Returns { entry: [...], filter: [...], ... }
// preserving sweep_weight order within each category.
function groupByCategory(schema) {
  const out = {};
  if (!schema) return out;
  for (const sec of (schema.sections || [])) {
    const cat = sec.category || 'other';
    if (!out[cat]) out[cat] = [];
    out[cat].push(sec);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (a.sweep_weight ?? 99) - (b.sweep_weight ?? 99));
  }
  return out;
}

// ── Category outer collapsible ──────────────────────────────────────
function CategoryBlock({ cat, sections, schema, recipe, onRowChange }) {
  const catTotal = sections.reduce(
    (acc, s) => acc * configCountForSection(schema, s, recipe), 1
  );
  return (
    <SchemaSection
      id={`sweep.cat.${cat}`}
      title={CATEGORY_LABEL[cat] || cat}
      defaultOpen={cat !== 'lifecycle'}
      badge={catTotal > 1 ? `${fmtCount(catTotal)} ×` : null}
    >
      <div className="pl-2">
        {sections.map(sec => (
          <SchemaSection
            key={sec.id}
            id={`sweep.sec.${sec.id}`}
            title={sec.title}
            defaultOpen={!sec.collapsed}
            badge={fmtCount(configCountForSection(schema, sec, recipe)) + ' ×'}
          >
            {flattenRows(sec).map(key => (
              <SweepRow
                key={key}
                schemaField={{ ...schema.params[key], name: key }}
                recipe={recipe[key]}
                onChange={(next) => onRowChange(key, next)}
              />
            ))}
          </SchemaSection>
        ))}
      </div>
    </SchemaSection>
  );
}

function flattenRows(section) {
  const out = [];
  for (const row of (section.rows || [])) {
    for (const col of (row.cols || [])) {
      if (col.key) out.push(col.key);
    }
  }
  return out;
}

// ── Toolbar ─────────────────────────────────────────────────────────
function Toolbar({ schema, recipe, total, job, submitting, onSubmit, onCancel,
                   submitError, drawerOpen, onToggleDrawer }) {
  const tooBig = total > 10_000_000;
  const empty  = total < 1;
  const running = job && (job.meta?.state === 'starting' || job.meta?.state === 'running');
  return (
    <div className="bg-panel border-b border-border px-3 py-1 flex items-center gap-3 text-xs">
      <span className="font-semibold text-sm">Sweep Definition</span>
      <span className="text-muted">strategy <code className="text-text">{STRATEGY}</code></span>
      {submitError && (
        <span className="text-short text-[11px] truncate max-w-[40%]" title={submitError}>
          {submitError}
        </span>
      )}
      <span className="ml-auto flex items-center gap-3">
        <span className="text-muted text-[11px] tnum">
          total configs <span className={
            empty   ? 'text-short font-bold' :
            tooBig  ? 'text-short font-bold' :
            total > 1_000_000 ? 'text-accent font-bold' :
                                'text-text font-semibold'
          }>{fmtCount(total)}</span>
        </span>
        <button
          type="button"
          onClick={onToggleDrawer}
          title="show / hide the recipe JSON that coord will receive"
          className={'px-2 py-0.5 rounded border text-[10px] font-mono ' +
            (drawerOpen
              ? 'bg-accent/20 text-accent border-accent/60'
              : 'bg-bg text-muted border-border hover:text-text hover:border-muted')}
        >
          {'{ }'}
        </button>
        {running ? (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-0.5 rounded bg-short/10 text-short border border-short/40 hover:bg-short/20"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting || empty || tooBig}
            onClick={onSubmit}
            title={tooBig ? 'reduce sweep before submitting' : 'POST recipe to coord /api/sweeps'}
            className={'px-3 py-0.5 rounded border ' +
              ((submitting || empty || tooBig)
                ? 'bg-accent/10 text-accent border-accent/30 opacity-40 cursor-not-allowed'
                : 'bg-accent/20 text-accent border-accent/60 hover:bg-accent/30')}
          >
            {submitting ? 'submitting…' : 'Submit'}
          </button>
        )}
      </span>
    </div>
  );
}

// ── Job status (right gutter while a sweep is running / done) ────────
function JobStatus({ job, onCancel }) {
  const last = job.progress?.[job.progress.length - 1];
  const m    = last?.m ?? job.meta?.n_configs ?? 0;
  const n    = last?.n ?? job.meta?.last_progress_n ?? 0;
  const pct  = m > 0 ? Math.min(100, (n / m) * 100) : 0;
  const eta  = last?.eta_sec ?? job.meta?.last_progress_eta;
  const rate = last?.rate ?? job.meta?.last_progress_rate;
  const state = job.meta?.state || 'starting';
  return (
    <div className="w-[420px] min-h-0 border-l border-border bg-bg flex flex-col">
      <div className="px-3 py-1 border-b border-border flex items-center gap-2">
        <span className={'text-[10px] uppercase tracking-wide font-bold ' +
          (state === 'done'      ? 'text-long' :
           state === 'error'     ? 'text-short' :
           state === 'cancelled' ? 'text-muted' : 'text-accent')}>
          {state}
        </span>
        <code className="text-[10px] text-muted truncate" title={job.sweep_id}>
          {job.sweep_id}
        </code>
        {state === 'running' && (
          <button
            onClick={onCancel}
            className="ml-auto px-2 py-0.5 rounded text-[10px] text-short hover:bg-short/10"
          >cancel</button>
        )}
      </div>
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-muted">progress</span>
          <span className="text-text tnum font-semibold">
            {fmtCount(n)} / {fmtCount(m)}
          </span>
        </div>
        <div className="h-1.5 bg-panel rounded mt-1 overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: pct + '%' }} />
        </div>
        <div className="flex justify-between text-[10px] text-muted tnum mt-1">
          <span>{rate != null ? `${rate.toFixed(0)} cfg/s` : '—'}</span>
          <span>{eta != null ? `ETA ${fmtEta(eta)}` : ''}</span>
        </div>
      </div>
      {job.stderr?.length > 0 && (
        <div className="px-3 py-1 text-[10px] text-short border-b border-border max-h-24 overflow-y-auto">
          {job.stderr.slice(-10).map((s, i) => (
            <div key={i} className="truncate" title={s.line}>{s.line}</div>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-1 text-[10px] text-muted font-mono">
        {(job.progress || []).slice(-50).map((p, i) => (
          <div key={i} className="truncate" title={p.raw}>{p.raw}</div>
        ))}
      </div>
    </div>
  );
}

function fmtEta(sec) {
  if (sec == null) return '—';
  if (sec < 60)    return `${sec.toFixed(0)}s`;
  if (sec < 3600)  return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

// ── Sweep results (right pane when no live job) ─────────────────────
// Loads results.jsonl via coord's paginated endpoint; sorts by
// pnl_dollars desc; renders a compact table. Empty-state shows a
// hint + the most-recent submitted-but-not-completed sweep id.
function SweepResults({ sweepId, job }) {
  const [rows, setRows]   = useState(null);
  const [err, setErr]     = useState(null);
  const [sortKey, setSortKey] = useState('pnl_dollars');
  const [sortDir, setSortDir] = useState('desc');

  useEffect(() => {
    if (!sweepId) { setRows(null); return; }
    let cancelled = false;
    fetchResults(sweepId, { limit: 1000 })
      .then(r => { if (!cancelled) setRows(r.results || []); })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [sweepId]);

  if (!sweepId && !job) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-xs text-muted gap-2">
        <span className="text-[11px]">No sweep results yet.</span>
        <span className="text-[10px] text-muted/70">Click <span className="text-accent">Submit</span> above to run one.</span>
      </div>
    );
  }
  if (err) return <div className="p-3 text-xs text-short">{err}</div>;
  if (rows === null) return <div className="p-3 text-xs text-muted">loading results…</div>;
  if (rows.length === 0) {
    return <div className="p-3 text-xs text-muted">sweep <code>{sweepId}</code> finished with no result rows.</div>;
  }

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  // Discover all metric columns from the first row. Numeric keys only.
  const sample  = rows[0];
  const allKeys = Object.keys(sample);
  const dimKeys = allKeys.filter(k => k.startsWith('config') || ['fast_period','slow_period','atr_period'].includes(k));
  const metricKeys = allKeys.filter(k => !dimKeys.includes(k));

  const setSort = (k) => {
    if (k === sortKey) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-1 border-b border-border flex items-center gap-2 text-[11px]">
        <span className="text-[10px] uppercase tracking-wide text-muted">results</span>
        <code className="text-[10px] text-muted truncate" title={sweepId}>{sweepId}</code>
        <span className="ml-auto text-muted tnum">{rows.length} rows</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-[11px] tnum">
          <thead className="sticky top-0 bg-panel border-b border-border">
            <tr>
              {dimKeys.map(k => (
                <th key={k} onClick={() => setSort(k)}
                    className="px-2 py-1 text-left text-[10px] uppercase tracking-wide text-muted cursor-pointer hover:text-text">
                  {k} {sortKey === k && (sortDir === 'desc' ? '↓' : '↑')}
                </th>
              ))}
              {metricKeys.map(k => (
                <th key={k} onClick={() => setSort(k)}
                    className="px-2 py-1 text-right text-[10px] uppercase tracking-wide text-muted cursor-pointer hover:text-text">
                  {k} {sortKey === k && (sortDir === 'desc' ? '↓' : '↑')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i} className="border-b border-border/30 hover:bg-accent/[0.04]">
                {dimKeys.map(k => (
                  <td key={k} className="px-2 py-0.5 text-muted">{String(r[k])}</td>
                ))}
                {metricKeys.map(k => (
                  <td key={k} className={'px-2 py-0.5 text-right ' +
                    (k.startsWith('pnl') && typeof r[k] === 'number'
                      ? (r[k] > 0 ? 'text-long' : r[k] < 0 ? 'text-short' : 'text-muted')
                      : 'text-text')}>
                    {fmtMetric(r[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtMetric(v) {
  if (v == null) return '—';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toFixed(2);
  }
  return String(v);
}

// ── Recipe drawer (toggleable bottom panel) ─────────────────────────
// Hidden by default; shown via toolbar's `{ }` toggle. The JSON is
// useful for verification but not for everyday use, so it lives here
// rather than occupying the right pane.
function RecipeDrawer({ schema, recipe, total, onClose }) {
  const payload = useMemo(
    () => toSubmitPayload(STRATEGY, schema, recipe),
    [schema, recipe]
  );
  return (
    <div className="absolute inset-x-0 bottom-0 h-72 border-t border-border bg-bg z-20 flex flex-col shadow-2xl">
      <div className="px-3 py-1 border-b border-border flex items-center gap-3 text-[11px]">
        <span className="text-[10px] uppercase tracking-wide text-muted">recipe payload</span>
        <span className="text-muted tnum">
          {fmtCount(total)} configs · {countSwept(payload)} swept dims
        </span>
        <button
          onClick={onClose}
          className="ml-auto px-2 py-0.5 rounded text-[10px] text-muted hover:text-text hover:bg-panel"
          title="close drawer"
        >close</button>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto px-3 py-2 text-[10px] leading-tight text-text font-mono whitespace-pre-wrap">
{JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}

function countSwept(payload) {
  let n = 0;
  for (const r of Object.values(payload?.recipe || {})) {
    if (r?.sweep) n++;
  }
  return n;
}

function fmtCount(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + 'K';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M';
  if (n < 1e12) return (n / 1e9).toFixed(n < 1e10 ? 2 : 1) + 'B';
  if (n < 1e15) return (n / 1e12).toFixed(2) + 'T';
  return n.toExponential(2);
}
