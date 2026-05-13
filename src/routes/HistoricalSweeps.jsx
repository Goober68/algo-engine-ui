// Sweep Definition UI. Schema-driven recipe builder: render the full
// xovd_v1 schema grouped by category (entry/filter/exit/risk/lifecycle)
// → sections (collapsible) → rows of SweepRow controls. Footer shows
// total cartesian product + per-section badges.
//
// Submit button is visible-but-disabled until coord's /api/sweeps lands
// (engine-claude is reshaping xovdV1KernelSweep.exe lifecycle + adding
// `[progress]` printf; my coord-side scaffold mirrors the playground
// REST shape and is queued behind that). Form is fully usable today
// for design + cartesian-count exploration.

import { useEffect, useMemo, useState } from 'react';
import { fetchStrategySchema } from '../data/strategySchema';
import SchemaSection from '../components/schema/SchemaSection';
import SweepRow from '../components/schema/SweepRow';
import {
  configCountForSection, initialRecipe, toSubmitPayload, totalConfigs,
} from '../components/schema/sweepRecipe';

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

export default function HistoricalSweeps() {
  const [schema, setSchema]   = useState(null);
  const [error, setError]     = useState(null);
  const [recipe, setRecipe]   = useState(null);

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

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Toolbar schema={schema} recipe={recipe} total={total} />
      <div className="flex-1 min-h-0 flex">
        {/* Recipe form (left) */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-panel">
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
        {/* Right gutter — preview panel (recipe JSON, eventual progress feed) */}
        <RecipePreview schema={schema} recipe={recipe} total={total} />
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
function Toolbar({ schema, recipe, total }) {
  const tooBig = total > 10_000_000;
  const empty  = total < 1;
  return (
    <div className="bg-panel border-b border-border px-3 py-1 flex items-center gap-3 text-xs">
      <span className="font-semibold text-sm">Sweep Definition</span>
      <span className="text-muted">strategy <code className="text-text">{STRATEGY}</code></span>
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
          disabled
          title="coord /api/sweeps endpoint pending engine-claude's sweep CLI reshape + [progress] printf"
          className="px-3 py-0.5 rounded bg-accent/10 text-accent border border-accent/30 opacity-40 cursor-not-allowed"
        >
          Submit (pending)
        </button>
      </span>
    </div>
  );
}

// ── Recipe preview (right gutter) ───────────────────────────────────
// Pretty-prints the submission payload so the user sees what coord
// would receive. Useful while iterating on the recipe shape.
function RecipePreview({ schema, recipe, total }) {
  const payload = useMemo(
    () => toSubmitPayload(STRATEGY, schema, recipe),
    [schema, recipe]
  );
  return (
    <div className="w-[420px] min-h-0 border-l border-border bg-bg flex flex-col">
      <div className="px-3 py-1 border-b border-border text-[10px] uppercase tracking-wide text-muted">
        Recipe payload (read-only)
      </div>
      <div className="px-3 py-1 text-[11px] text-muted border-b border-border tnum">
        {fmtCount(total)} configs · {countSwept(payload)} swept dims
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
