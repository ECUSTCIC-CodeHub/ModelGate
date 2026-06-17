"use client";

import { useCallback, useEffect, useState } from "react";

export interface ColumnWidthDef {
  key: string;
  defaultWidth: number;
  minWidth: number;
}

const STORAGE_KEY = "modelgate:column-widths";

function loadStoredWidths(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, number>;
    return {};
  } catch {
    return {};
  }
}

function saveStoredWidths(widths: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // ignore
  }
}

export function useResizableColumns(columns: ColumnWidthDef[], scope: string) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const stored = loadStoredWidths();
    const scopedKey = `${scope}:`;
    const initial: Record<string, number> = {};
    for (const col of columns) {
      const storedKey = `${scopedKey}${col.key}`;
      const storedValue = stored[storedKey];
      initial[col.key] =
        typeof storedValue === "number" && storedValue >= col.minWidth
          ? storedValue
          : col.defaultWidth;
    }
    return initial;
  });

  useEffect(() => {
    const stored = loadStoredWidths();
    const scopedKey = `${scope}:`;
    let changed = false;
    const merged = { ...stored };
    for (const col of columns) {
      const storedKey = `${scopedKey}${col.key}`;
      const w = widths[col.key];
      if (typeof w === "number" && w !== merged[storedKey]) {
        merged[storedKey] = w;
        changed = true;
      }
    }
    if (changed) saveStoredWidths(merged);
  }, [widths, columns, scope]);

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
