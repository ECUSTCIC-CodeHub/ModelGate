import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-sm border border-white/20 bg-slate-950/50 shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(159,232,216,0.35)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[rgba(159,232,216,0.35)] data-[state=checked]:bg-[linear-gradient(135deg,#a6f1de_0%,#7ee0d2_100%)] data-[state=checked]:text-slate-950",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="h-3.5 w-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
