import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PageToolbarProps = {
  children: ReactNode;
  className?: string;
};

export function PageToolbar({ children, className }: PageToolbarProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4 md:flex-row md:items-center md:justify-between",
        className,
      )}
    >
      {children}
    </div>
  );
}
