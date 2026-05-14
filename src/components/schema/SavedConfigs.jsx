// Toolbar dropdown + Save dialog for playground saved configs.
//
//   [▾ Configs]   ← dropdown lists local + remote, click to load
//   [+ Save]      ← opens a dialog: name + local/remote toggle
//
// Two storage tiers (configsClient.js). Remote requires an active
// coord; local is always available.

import { useEffect, useRef, useState } from 'react';
import {
  deleteLocal, deleteRemote,
  getLocal, getRemote,
  listAll, saveLocal, saveRemote,
} from '../../data/configsClient';

export default function SavedConfigs({ strategy, currentValues, onLoad, onReset }) {
  const [open, setOpen]       = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [list, setList]       = useState({ local: [], remote: [] });
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);
  const rootRef = useRef(null);

  const refresh = async () => {
    try {
      setList(await listAll(strategy));
    } catch (e) {
      setErr(e.message || String(e));
    }
  };
  useEffect(() => { refresh(); }, [strategy]);

  // Close dropdown on outside-click / Escape.
  useEffect(() => {
    if (!open && !saveOpen) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false); setSaveOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setSaveOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, saveOpen]);

  const loadCfg = async (cfg) => {
    setBusy(true); setErr(null);
    try {
      const fetched = cfg.tier === 'remote' ? await getRemote(cfg.id) : getLocal(cfg.id);
      if (!fetched) throw new Error('config not found');
      onLoad?.(fetched);
      setOpen(false);
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setBusy(false); }
  };

  const removeCfg = async (cfg, e) => {
    e?.stopPropagation();
    if (!window.confirm(`Delete "${cfg.name}" (${cfg.tier})?`)) return;
    try {
      if (cfg.tier === 'remote') await deleteRemote(cfg.id);
      else                       deleteLocal(cfg.id);
      refresh();
    } catch (e) { setErr(e.message || String(e)); }
  };

  return (
    <div ref={rootRef} className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setSaveOpen(false); }}
        title="Load a saved playground config"
        className="px-2 py-0.5 rounded border border-border bg-bg text-muted text-[10px] hover:text-text hover:border-muted"
      >
        Configs <span className="text-muted/60">▾</span>
      </button>
      <button
        type="button"
        onClick={() => { setSaveOpen(o => !o); setOpen(false); }}
        title="Save current sliders as a config"
        className="px-2 py-0.5 rounded border border-accent/40 bg-accent/10 text-accent text-[10px] hover:bg-accent/20"
      >
        + Save
      </button>
      {onReset && (
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Reset all sliders to schema defaults?')) onReset();
          }}
          title="Reset every slider to its schema default value"
          className="px-2 py-0.5 rounded border border-border bg-bg text-muted text-[10px] hover:text-text hover:border-muted"
        >
          Reset
        </button>
      )}

      {open && (
        <ConfigsList
          list={list}
          busy={busy}
          err={err}
          onLoad={loadCfg}
          onDelete={removeCfg}
        />
      )}
      {saveOpen && (
        <SaveDialog
          strategy={strategy}
          currentValues={currentValues}
          onSaved={() => { setSaveOpen(false); refresh(); }}
          onCancel={() => setSaveOpen(false)}
        />
      )}
    </div>
  );
}

// ── Dropdown of saved configs (local + remote, separated) ───────────
function ConfigsList({ list, busy, err, onLoad, onDelete }) {
  const total = list.local.length + list.remote.length;
  return (
    <div className="absolute z-30 top-full right-0 mt-1 w-80 max-h-96 overflow-y-auto
                    bg-panel border border-border rounded shadow-lg text-[11px]">
      {err && (
        <div className="px-2 py-1 text-short text-[10px] border-b border-border">
          {err}
        </div>
      )}
      {total === 0 && !busy && (
        <div className="px-3 py-3 text-muted italic">No saved configs.</div>
      )}
      {list.remote.length > 0 && (
        <Section label="remote" cls="text-accent">
          {list.remote.map(c => (
            <Row key={c.id} cfg={c} onLoad={onLoad} onDelete={onDelete} />
          ))}
        </Section>
      )}
      {list.local.length > 0 && (
        <Section label="local" cls="text-muted">
          {list.local.map(c => (
            <Row key={c.id} cfg={c} onLoad={onLoad} onDelete={onDelete} />
          ))}
        </Section>
      )}
    </div>
  );
}
function Section({ label, cls, children }) {
  return (
    <div>
      <div className={'px-2 py-0.5 text-[9px] uppercase tracking-wide ' + cls +
                      ' bg-bg/50 border-b border-border'}>
        {label}
      </div>
      {children}
    </div>
  );
}
function Row({ cfg, onLoad, onDelete }) {
  return (
    <button
      type="button"
      onClick={() => onLoad(cfg)}
      className="w-full flex items-baseline justify-between gap-2 px-2 py-1
                 hover:bg-accent/10 text-left border-b border-border/30"
    >
      <span className="text-text truncate flex-1">{cfg.name}</span>
      <span className="text-muted text-[9px] tnum shrink-0">{fmtAge(cfg.created_at)}</span>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => onDelete(cfg, e)}
        onKeyDown={(e) => { if (e.key === 'Enter') onDelete(cfg, e); }}
        title="Delete"
        className="px-1 text-short/60 hover:text-short cursor-pointer"
      >×</span>
    </button>
  );
}

// ── Save dialog ─────────────────────────────────────────────────────
function SaveDialog({ strategy, currentValues, onSaved, onCancel }) {
  const [name, setName]   = useState('');
  const [tier, setTier]   = useState('remote');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    if (!name.trim()) { setErr('Name required'); return; }
    setBusy(true); setErr(null);
    try {
      if (tier === 'remote') {
        await saveRemote({ name: name.trim(), strategy, values: currentValues });
      } else {
        saveLocal({ name: name.trim(), strategy, values: currentValues });
      }
      onSaved?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setBusy(false); }
  };

  return (
    <form
      onSubmit={submit}
      className="absolute z-30 top-full right-0 mt-1 w-72
                 bg-panel border border-border rounded shadow-lg text-[11px] p-2 flex flex-col gap-2"
    >
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Config name"
        className="w-full px-2 py-1 bg-bg border border-border rounded text-text text-[11px]"
      />
      <div className="flex gap-1">
        <TierBtn label="remote" desc="shared via coord"
                 active={tier === 'remote'} onClick={() => setTier('remote')} />
        <TierBtn label="local"  desc="this browser only"
                 active={tier === 'local'}  onClick={() => setTier('local')} />
      </div>
      {err && <div className="text-short text-[10px]">{err}</div>}
      <div className="flex gap-1 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-0.5 rounded border border-border text-muted hover:text-text"
        >
          cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="px-2 py-0.5 rounded border border-accent/60 bg-accent/20 text-accent disabled:opacity-50"
        >
          {busy ? 'saving…' : 'save'}
        </button>
      </div>
    </form>
  );
}
function TierBtn({ label, desc, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={desc}
      className={
        'flex-1 px-2 py-1 rounded border text-[10px] ' +
        (active
          ? 'bg-accent/20 text-accent border-accent/60'
          : 'bg-bg text-muted border-border hover:text-text hover:border-muted')
      }
    >
      {label}
    </button>
  );
}

function fmtAge(epochSec) {
  if (!epochSec) return '';
  const ageSec = Date.now() / 1000 - epochSec;
  if (ageSec < 60)    return `${Math.round(ageSec)}s`;
  if (ageSec < 3600)  return `${Math.round(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h`;
  return `${Math.round(ageSec / 86400)}d`;
}
