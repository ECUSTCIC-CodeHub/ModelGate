import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/shared/utils";

const badgeVariants = cva(
  "cursor-default inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium transition-colors duration-200",
  {
    variants: {
      variant: {
        default: "border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] text-[var(--color-accent)]",
        secondary: "border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-foreground-secondary)]",
        outline: "border-[var(--color-border)] text-[var(--color-foreground-muted)]",
        destructive: "border-[var(--color-destructive)]/20 bg-[var(--color-destructive)]/10 text-[var(--color-destructive)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
