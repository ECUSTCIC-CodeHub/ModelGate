"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

const Switch = ({ className, ...props }: React.ComponentProps<typeof SwitchPrimitives.Root>) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(159,232,216,0.35)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[linear-gradient(135deg,#a6f1de_0%,#7ee0d2_100%)]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
);

export { Switch };
