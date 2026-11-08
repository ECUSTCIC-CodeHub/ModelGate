import { jsx as _jsx } from "react/jsx-runtime";
import { cn } from "@/lib/shared/utils";
export function Label({ className, ...props }) {
    return (_jsx("label", { className: cn("text-sm font-medium leading-none text-[var(--color-foreground-secondary)] cursor-pointer peer-disabled:cursor-not-allowed peer-disabled:opacity-50", className), ...props }));
}
