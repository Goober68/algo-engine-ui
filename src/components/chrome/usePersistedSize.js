// usePersistedSize — like useState(initial) but saves to localStorage
// under `key`. Used by splitter consumers so panel sizes survive page
// reload.

import { useEffect, useState } from 'react';

export function usePersistedSize(key, initial) {
  const [size, setSize] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      const v = raw == null ? null : Number(raw);
      return Number.isFinite(v) ? v : initial;
    } catch { return initial; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, String(size)); } catch {}
  }, [key, size]);
  return [size, setSize];
}
