"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({
                             className,
                             classNames,
                             showOutsideDays = true,
                             ...props
                         }: CalendarProps) {
    return (
        <DayPicker
            showOutsideDays={showOutsideDays}
            className={cn("p-0", className)}
            classNames={{
                months: "flex flex-col gap-4",
                month: "space-y-3",
                month_caption: "relative flex items-center justify-center px-8 py-1",
                caption_label: "text-sm font-medium text-[var(--color-foreground)]",
                nav: "absolute inset-x-0 top-0 flex items-center justify-between px-0.5",
                button_previous: cn(
                    buttonVariants({ variant: "ghost", size: "icon" }),
                    "h-7 w-7 rounded-md border border-[var(--color-border)] p-0 text-[var(--color-foreground-secondary)] hover:bg-[var(--color-surface-hover)]",
                ),
                button_next: cn(
                    buttonVariants({ variant: "ghost", size: "icon" }),
                    "h-7 w-7 rounded-md border border-[var(--color-border)] p-0 text-[var(--color-foreground-secondary)] hover:bg-[var(--color-surface-hover)]",
                ),
                month_grid: "w-full border-collapse",
                weekdays: "flex",
                weekday: "w-9 py-1 text-center text-[0.72rem] font-medium text-[var(--color-foreground-muted)]",
                weeks: "mt-1 flex flex-col gap-1",
                week: "flex w-full",
                day: "relative h-9 w-9 p-0 text-center text-sm focus-within:relative focus-within:z-20",
                day_button: cn(
                    buttonVariants({ variant: "ghost", size: "icon" }),
                    "h-9 w-9 rounded-md p-0 font-normal text-[var(--color-foreground)] shadow-none hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]",
                ),
                selected: "bg-[var(--color-accent)] text-[var(--color-accent-foreground)] rounded-md hover:bg-[var(--color-accent-hover)]",
                today: "rounded-md border border-[var(--color-border-hover)] bg-[var(--color-surface-hover)] text-[var(--color-foreground)]",
                outside: "text-[var(--color-foreground-subtle)] opacity-40",
                disabled: "text-[var(--color-foreground-subtle)] opacity-30 pointer-events-none",
                hidden: "invisible",
                ...classNames,
            }}
            components={{
                Chevron: ({ orientation, className: iconClassName, ...iconProps }) =>
                    orientation === "left" ? (
                        <ChevronLeft className={cn("h-4 w-4", iconClassName)} {...iconProps} />
                    ) : (
                        <ChevronRight className={cn("h-4 w-4", iconClassName)} {...iconProps} />
                    ),
            }}
            {...props}
        />
    );
}