import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium shadow-[0_12px_30px_rgba(3,8,20,0.18)] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(159,232,216,0.45)]",
  {
    variants: {
      variant: {
        default:
          "border border-[rgba(159,232,216,0.2)] bg-[linear-gradient(135deg,#a6f1de_0%,#7ee0d2_100%)] text-slate-950 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgba(126,224,210,0.25)]",
        secondary:
          "border border-white/10 bg-white/8 text-zinc-100 hover:-translate-y-0.5 hover:bg-white/14",
        outline:
          "border border-white/12 bg-slate-950/40 text-zinc-100 hover:-translate-y-0.5 hover:border-[rgba(159,232,216,0.26)] hover:bg-slate-900/80",
        ghost: "text-zinc-300 shadow-none hover:bg-white/6 hover:text-white",
        destructive: "bg-red-600 text-white hover:bg-red-500",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-lg px-3",
        lg: "h-11 rounded-xl px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
