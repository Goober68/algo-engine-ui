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
// Hard cap that mirrors coord/sweep_recipe.py:HARD_CONFIG_CEILING. Submit
// is disabled and the count badge turns red above this; coord rejects
// with a 400 anyway, but the UI gives feedback before the round-trip.
const MAX_CONFIGS = 100_000_000;

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
  const [formWidth, setFormWidth]     = useState(() => {
    const v = parseInt(localStorage.getItem('lab.sweeps.formWidth') || '', 10);
    return Number.isFinite(v) && v >= 320 ? v : 640;
  });
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
        {/* Recipe form (left) — width is user-draggable via Splitter */}
        <div style={{ width: formWidth }}
             className="shrink-0 min-h-0 overflow-y-auto bg-panel">
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
        <Splitter
          width={formWidth}
          onChange={(w) => {
            setFormWidth(w);
            localStorage.setItem('lab.sweeps.formWidth', String(w));
          }}
        />
        {/* Right pane — fills remaining width. Job status while running,
            then results from the most-recent completed sweep. */}
        <div className="flex-1 min-h-0 flex flex-col">
          {job && (job.meta?.state === 'starting' || job.meta?.state === 'running')
            ? <JobStatus job={job} onCancel={onCancel} />
            : <SweepResults sweepId={lastSweepId} job={job} />}
        </div>
      </div>
      {/* Sticky bottom-right dimensionality. Pinned to the right edge
          of the form column so it tracks the splitter. */}
      <BottomDimBadge total={total} formWidth={formWidth} />
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

// Sticky badge anchored to the form column's right edge so it doesn't
// overlap the results pane.
function BottomDimBadge({ total, formWidth }) {
  const tooBig = total > MAX_CONFIGS;
  const empty  = total < 1;
  return (
    <div className="absolute bottom-2 pointer-events-none"
         style={{ left: Math.max(120, (formWidth ?? 640) - 120) }}>
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

// Draggable vertical splitter between recipe form and results pane.
// Width persists to localStorage; mouse drag updates form width and
// constrains it so neither pane drops below a usable size.
function Splitter({ width, onChange }) {
  const onMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const next = startW + (ev.clientX - startX);
      const max = window.innerWidth - 360;     // leave room for results pane
      const w = Math.max(320, Math.min(max, next));
      onChange(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return (
    <div
      onMouseDown={onMouseDown}
      title="drag to resize"
      className="w-1 shrink-0 bg-border hover:bg-accent/60 cursor-col-resize transition-colors relative group"
    >
      {/* Wider invisible hit area for easier grabbing */}
      <div className="absolute -left-1 -right-1 top-0 bottom-0" />
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
  const tooBig = total > MAX_CONFIGS;
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
      {tooBig && !submitError && (
        <span className="text-short text-[11px] font-semibold"
              title={`hard cap is ${fmtCount(MAX_CONFIGS)}; reduce sweep dims or step granularity`}>
          ! exceeds {fmtCount(MAX_CONFIGS)} cap
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
          {tooBig && <span className="text-short ml-1">/ {fmtCount(MAX_CONFIGS)} cap</span>}
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
            title={tooBig
              ? `recipe exceeds ${fmtCount(MAX_CONFIGS)}-config hard cap; reduce sweep dims or step granularity before submitting`
              : 'POST recipe to coord /api/sweeps'}
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
        <button
          type="button"
          disabled
          title="pareto.exe binary format (V5) is ACD-EA-specific 17×9 axes; XOVD V6 schema pending engine-claude"
          className="ml-2 px-2 py-0.5 rounded border border-border text-[10px] text-muted/60 opacity-50 cursor-not-allowed"
        >
          View in pareto (pending)
        </button>
      </div>
      <SummaryStrip rows={rows} metric="pnl_dollars" />
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

// ── Summary strip above the per-config table ────────────────────────
// Glanceable answer to "did this sweep find a winner?" without having
// to scan rows. Best/worst/median PnL + count-positive vs count-negative
// + tiny SVG histogram of the distribution. Defaults to pnl_dollars
// but accepts any numeric metric key.
function SummaryStrip({ rows, metric }) {
  const stats = useMemo(() => computeStats(rows, metric), [rows, metric]);
  if (!stats) return null;
  const { n, nPos, nNeg, nZero, best, worst, median, mean, bins, binMax } = stats;
  return (
    <div className="px-3 py-2 border-b border-border bg-bg/50 flex items-center gap-4 text-[11px]">
      <div className="flex flex-col leading-tight">
        <span className="text-[9px] uppercase tracking-wide text-muted">configs</span>
        <span className="tnum text-text font-semibold">{n.toLocaleString()}</span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[9px] uppercase tracking-wide text-muted">pos / neg</span>
        <span className="tnum">
          <span className="text-long">{nPos}</span>
          <span className="text-muted"> / </span>
          <span className="text-short">{nNeg}</span>
          {nZero > 0 && <span className="text-muted"> / {nZero}</span>}
        </span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[9px] uppercase tracking-wide text-muted">best</span>
        <span className="tnum text-long font-semibold">{fmtCurrency(best)}</span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[9px] uppercase tracking-wide text-muted">median</span>
        <span className={'tnum font-semibold ' + (median >= 0 ? 'text-long/80' : 'text-short/80')}>
          {fmtCurrency(median)}
        </span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[9px] uppercase tracking-wide text-muted">mean</span>
        <span className={'tnum ' + (mean >= 0 ? 'text-long/80' : 'text-short/80')}>
          {fmtCurrency(mean)}
        </span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[9px] uppercase tracking-wide text-muted">worst</span>
        <span className="tnum text-short font-semibold">{fmtCurrency(worst)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <PnlHistogram bins={bins} binMax={binMax} />
      </div>
    </div>
  );
}

function computeStats(rows, metric) {
  const vals = rows.map(r => r[metric]).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / vals.length;
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) >> 1]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const nPos  = vals.filter(v => v > 0).length;
  const nNeg  = vals.filter(v => v < 0).length;
  const nZero = vals.filter(v => v === 0).length;

  // Histogram: 24 bins spanning [worst, best]. Tracks signed bins so
  // we can color positive vs negative without a second pass.
  const N_BINS = 24;
  const min = sorted[0], max = sorted[sorted.length - 1];
  const span = max - min || 1;
  const bins = new Array(N_BINS).fill(0);
  for (const v of vals) {
    const idx = Math.min(N_BINS - 1, Math.max(0, Math.floor(((v - min) / span) * N_BINS)));
    bins[idx]++;
  }
  const binMax = Math.max(...bins, 1);
  return { n: vals.length, nPos, nNeg, nZero, best: max, worst: min,
           median, mean, bins, binMax };
}

function PnlHistogram({ bins, binMax }) {
  // Inline SVG; 24 bars, fixed height 28px. Bars left-of-center are
  // negative-PnL bins (red), right-of-center are positive (green). The
  // exact pos/neg threshold is the bin containing zero — we approximate
  // by splitting at the bin index closest to (0 - min) / span.
  const W = 280, H = 28;
  const barW = W / bins.length;
  return (
    <svg width={W} height={H} className="block">
      {bins.map((v, i) => {
        const h = (v / binMax) * H;
        const x = i * barW;
        const y = H - h;
        // Color heuristic: bins skewing left (lower index) trend toward
        // worst/negative, right toward best/positive.
        const t = i / (bins.length - 1);
        const fill = t < 0.45 ? 'fill-short/60' : t > 0.55 ? 'fill-long/60' : 'fill-muted/60';
        return (
          <rect key={i} x={x + 0.5} y={y} width={barW - 1} height={h}
                className={fill} />
        );
      })}
    </svg>
  );
}

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000)    return `${sign}$${(abs / 1000).toFixed(1)}K`;
  if (abs >= 1000)      return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(0)}`;
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
