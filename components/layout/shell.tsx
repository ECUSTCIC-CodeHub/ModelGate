import Link from "next/link";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string };

type ShellProps = {
  title: string;
  subtitle?: string;
  nav?: NavItem[];
  right?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Shell({ title, subtitle, nav = [], right, children, className }: ShellProps) {
  return (
    <main className={cn("min-h-screen bg-zinc-50 text-zinc-900", className)}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        <header className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle ? <p className="mt-1 text-sm text-zinc-500">{subtitle}</p> : null}
              {nav.length > 0 ? (
                <nav className="mt-3 flex flex-wrap gap-2">
                  {nav.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="rounded-md border border-zinc-200 bg-zinc-100 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-200"
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>
              ) : null}
            </div>
            {right ? <div>{right}</div> : null}
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}
