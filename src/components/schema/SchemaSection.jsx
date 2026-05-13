// Collapsible section header. Used by both the playground (12-field
// subset of XovdV1Config) and the upcoming sweep-definition UI (full
// ~30-field schema, multiple sections).
//
// Open/closed state is persisted per-section in localStorage so users
// don't re-collapse every tab visit. `defaultOpen` is the seed used
// only on first render before localStorage kicks in.

import { useEffect, useState } from 'react';

const LS_PREFIX = 'schema.section.open.v1.';

export default function SchemaSection({
  id, title, defaultOpen = true, badge, children,
}) {
  const lsKey = `${LS_PREFIX}${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = window.localStorage.getItem(lsKey);
      return v === null ? defaultOpen : v === '1';
    } catch { return defaultOpen; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(lsKey, open ? '1' : '0'); } catch {}
  }, [lsKey, open]);

  return (
    <div className="border-b border-border/40">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-accent/5 text-left"
      >
        <span
          className={'inline-block text-muted text-[10px] transition-transform ' +
                     (open ? 'rotate-90' : '')}
        >
          ▶
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted font-semibold">
          {title}
        </span>
        {badge != null && (
          <span className="text-[10px] text-muted/70 ml-auto tnum">{badge}</span>
        )}
      </button>
      {open && (
        <div className="pb-1">
          {children}
        </div>
      )}
    </div>
  );
}
