"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/shared/utils";

const Switch = ({ className, ...props }: React.ComponentProps<typeof SwitchPrimitives.Root>) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-border-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[var(--color-accent)] data-[state=checked]:bg-[var(--color-accent)]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-5 w-5 rounded-full bg-[var(--color-switch-thumb)] shadow-[var(--shadow-md)] ring-1 ring-[var(--color-border)] transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
);

export { Switch };
