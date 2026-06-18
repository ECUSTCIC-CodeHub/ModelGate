"use client";

import { type ReactNode, useState, useEffect } from "react";
import { Menu, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type DashboardTopbarProps = {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  theme: string;
  onToggleTheme: () => void;
  onOpenMobileNav: () => void;
};

export function DashboardTopbar({
  title,
  subtitle,
  right,
  theme,
  onToggleTheme,
  onOpenMobileNav,
}: DashboardTopbarProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const resolvedTheme = mounted ? theme : "light";
  const themeLabel = resolvedTheme === "dark" ? "切换到浅色模式" : "切换到深色模式";

  return (
    <header className="sticky top-3 z-20 rounded-lg border border-[var(--color-header-border)] bg-[var(--color-header-bg)] px-4 py-3 shadow-[var(--shadow-sm)] lg:px-5 lg:py-4 lg:backdrop-blur-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="hidden items-center gap-1.5 text-xs text-[var(--color-foreground-muted)] lg:flex">
            <span>Dashboard</span>
            <span>/</span>
            <span className="truncate text-[var(--color-foreground-secondary)]">{title}</span>
          </div>
          <h1 className="font-mono text-lg font-semibold text-[var(--color-foreground)] lg:mt-1 lg:text-2xl">{title}</h1>
          {subtitle ? <p className="mt-1 hidden max-w-3xl text-sm text-[var(--color-foreground-muted)] lg:block">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {right ? <div className="hidden items-center gap-2 sm:flex">{right}</div> : null}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={onToggleTheme}
                  aria-label={themeLabel}
                >
                  {resolvedTheme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{themeLabel}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button variant="outline" size="icon" className="lg:hidden" onClick={onOpenMobileNav}>
            <Menu className="h-4 w-4" />
            <span className="sr-only">打开菜单</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
