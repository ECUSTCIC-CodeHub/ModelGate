import { ReactNode } from "react";

type DashboardRouteLoadingProps = {
  children: ReactNode;
};

export function DashboardRouteLoading({ children }: DashboardRouteLoadingProps) {
  return (
    <main className="h-screen overflow-hidden bg-black text-zinc-100">
      <div className="flex h-full w-full gap-4 px-4 py-4 xl:px-6">
        <aside className="hidden h-full w-60 shrink-0 rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 md:flex md:flex-col">
          <div className="mb-3 h-4 w-24 animate-pulse rounded bg-zinc-800" />
          <div className="space-y-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-zinc-900" />
            ))}
          </div>
          <div className="mt-auto h-9 animate-pulse rounded bg-zinc-900" />
        </aside>
        <section className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-4 h-28 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-950/80" />
          <div className="h-[calc(100%-8rem)] min-h-0">{children}</div>
        </section>
      </div>
    </main>
  );
}

