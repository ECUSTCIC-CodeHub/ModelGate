"use client";

import { useCallback, useState } from "react";

export interface ColumnWidthDef {
  key: string;
  defaultWidth: number;
  minWidth: number;
}

export function useResizableColumns(columns: ColumnWidthDef[]) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const col of columns) {
      initial[col.key] = col.defaultWidth;
    }
    return initial;
  });

  const getResizeHandler = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const col = columns.find((c) => c.key === key);
      if (!col) return;

      const startX = e.clientX;
      const startWidth = widths[key];

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = Math.max(col.minWidth, startWidth + delta);
        setWidths((prev) => (prev[key] === newWidth ? prev : { ...prev, [key]: newWidth }));
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [columns, widths],
  );

  return { widths, getResizeHandler };
}
