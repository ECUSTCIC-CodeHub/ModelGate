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
                caption_label: "text-sm font-medium text-zinc-100",
                nav: "absolute inset-x-0 top-0 flex items-center justify-between px-0.5",
                button_previous: cn(
                    buttonVariants({ variant: "ghost", size: "icon" }),
                    "h-7 w-7 rounded-md border border-white/10 p-0 text-zinc-300 hover:bg-white/6",
                ),
                button_next: cn(
                    buttonVariants({ variant: "ghost", size: "icon" }),
                    "h-7 w-7 rounded-md border border-white/10 p-0 text-zinc-300 hover:bg-white/6",
                ),
                month_grid: "w-full border-collapse",
                weekdays: "flex",
                weekday: "w-9 py-1 text-center text-[0.72rem] font-medium text-zinc-500",
                weeks: "mt-1 flex flex-col gap-1",
                week: "flex w-full",
                day: "relative h-9 w-9 p-0 text-center text-sm focus-within:relative focus-within:z-20",
                day_button: cn(
                    buttonVariants({ variant: "ghost", size: "icon" }),
                    "h-9 w-9 rounded-md p-0 font-normal text-zinc-100 shadow-none hover:bg-white/6 hover:text-white",
                ),
                selected: "bg-slate-50 text-slate-950 rounded-md hover:bg-slate-100",
                today: "rounded-md border border-white/15 bg-white/5 text-zinc-100",
                outside: "text-zinc-600 opacity-40",
                disabled: "text-zinc-700 opacity-30 pointer-events-none",
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
