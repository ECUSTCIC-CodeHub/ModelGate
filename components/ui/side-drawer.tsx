"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SideDrawerProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export function SideDrawer({ open, onClose, title, description, children, className }: SideDrawerProps) {
  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-full max-w-xl border-l border-zinc-800 bg-zinc-950 shadow-2xl",
          "transform transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-zinc-800 px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
                {description ? <p className="mt-1 text-sm text-zinc-400">{description}</p> : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-200 hover:bg-zinc-900"
              >
                关闭
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </div>
      </aside>
    </>
  );
}
