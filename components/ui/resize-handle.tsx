"use client";

import React from "react";
import { cn } from "@/lib/shared/utils";

export function ResizeHandle({
  onMouseDown,
  className,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "absolute right-0 top-0 h-full w-2 cursor-col-resize select-none",
        "before:absolute before:inset-y-0 before:right-0 before:w-[3px]",
        "before:bg-[var(--color-border)] before:transition-colors before:duration-150",
        "hover:before:bg-[var(--color-accent)]",
        className,
      )}
      onMouseDown={onMouseDown}
    />
  );
}
