"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatUserAgent } from "./log-formatters";

type ClientInfoProps = {
  ip: string | null;
  userAgent: string | null;
};

export function ClientInfo({ ip, userAgent }: ClientInfoProps) {
  const shortUserAgent = formatUserAgent(userAgent);

  return (
    <div className="max-w-64 space-y-1 leading-tight">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 rounded-sm bg-[var(--color-popover-hover)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-foreground-muted)]">
          IP
        </span>
        <span className="truncate font-mono text-xs text-[var(--color-foreground-muted)]">{ip ?? "-"}</span>
      </div>
      {userAgent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 max-w-64 cursor-help items-center gap-1.5 rounded-sm text-left text-xs text-[var(--color-foreground-secondary)] transition-colors hover:text-[var(--color-accent)]"
            >
              <span className="shrink-0 rounded-sm bg-[var(--color-popover-hover)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-foreground-muted)]">
                UA
              </span>
              <span className="min-w-0 truncate underline decoration-[var(--color-border-strong)] underline-offset-2">{shortUserAgent}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent align="start" className="max-w-96">
            <p className="break-all font-mono text-[11px] leading-relaxed">{userAgent}</p>
          </TooltipContent>
        </Tooltip>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-foreground-muted)]">
          <span className="shrink-0 rounded-sm bg-[var(--color-popover-hover)] px-1.5 py-0.5 font-mono text-[10px]">
            UA
          </span>
          <span>-</span>
        </div>
      )}
    </div>
  );
}
