// Drag-handle splitter component. Two flavors:
//   <Splitter dir="col" .../>  — horizontal drag, splits a vertical
//                                 column-pair (left | right)
//   <Splitter dir="row" .../>  — vertical drag, splits a horizontal
//                                 row-pair (top / bottom)
//
// Lifts the pointer-capture overlay trick from the prior dashboard:
// during drag, an absolute-positioned full-window overlay at z-index
// 9999 captures pointer events so charts (lightweight-charts grabs
// pointer-down) can't steal the drag mid-motion.
//
// Controlled component — caller owns `size` (the px width of the
// LEFT pane for col, or the TOP pane for row) and `setSize`.

import { useEffect, useRef, useState } from 'react';

// invert: when the controlled panel is on the RIGHT (col) or BOTTOM
// (row) of the splitter handle, the size grows as the cursor moves
// AWAY from it (left/up). Set invert=true in that case.
export default function Splitter({ dir, size, setSize, min = 80, max = 2000, invert = false }) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ pos: 0, size: 0 });

  const onPointerDown = (e) => {
    e.preventDefault();
    startRef.current = {
      pos:  dir === 'col' ? e.clientX : e.clientY,
      size,
    };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const cur = dir === 'col' ? e.clientX : e.clientY;
      const delta = (cur - startRef.current.pos) * (invert ? -1 : 1);
      const next = Math.max(min, Math.min(max, startRef.current.size + delta));
      setSize(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, dir, min, max, setSize, invert]);

  // The handle itself: a thin strip with hover affordance. Cursor
  // changes to the appropriate resize cursor.
  const handleClass =
    dir === 'col'
      ? 'w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent'
      : 'h-1 cursor-row-resize hover:bg-accent/40 active:bg-accent';
  return (
    <>
      <div
        onPointerDown={onPointerDown}
        className={`shrink-0 bg-border ${handleClass}`}
        style={{ touchAction: 'none' }}
      />
      {dragging && (
        // Capture pointer events globally during drag so charts +
        // canvas overlays don't intercept moves. z-9999 + invisible
        // background; cursor reflects drag direction.
        <div
          className="fixed inset-0 z-[9999]"
          style={{ cursor: dir === 'col' ? 'col-resize' : 'row-resize' }}
        />
      )}
    </>
  );
}
