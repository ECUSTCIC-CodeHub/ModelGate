import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/shared/utils";
const buttonVariants = cva("cursor-pointer inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/35 focus-visible:ring-offset-1 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4", {
    variants: {
        variant: {
            default: "bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)] shadow-sm",
            secondary: "bg-[var(--color-surface-hover)] text-[var(--color-foreground)] hover:bg-[var(--color-border)] border border-[var(--color-border)]",
            outline: "border border-[var(--color-border)] bg-transparent text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-hover)]",
            ghost: "text-[var(--color-foreground-muted)] shadow-none hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]",
            destructive: "bg-[var(--color-destructive)] text-[var(--color-destructive-foreground)] hover:bg-[var(--color-destructive-hover)] shadow-sm",
        },
        size: {
            default: "h-10 px-4 py-2",
            sm: "h-8 px-3 text-xs rounded-md",
            lg: "h-11 px-8 rounded-md",
            icon: "h-10 w-10 rounded-md",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const roleProp = asChild ? { role: "button" } : {};
    return (_jsx(Comp, { className: cn(buttonVariants({ variant, size, className })), ref: ref, ...roleProp, ...props }));
});
Button.displayName = "Button";
export { Button, buttonVariants };
