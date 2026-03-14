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
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col gap-4",
        month: "space-y-4",
        caption: "relative flex items-center justify-center px-10 pt-1",
        caption_label: "text-sm font-semibold tracking-[0.02em] text-zinc-100",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        nav_button: cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "h-8 w-8 rounded-xl border border-white/6 bg-white/[0.03] p-0 text-zinc-300 hover:bg-white/[0.08]",
        ),
        table: "w-full border-collapse space-y-1",
        head_row: "flex",
        head_cell: "w-10 rounded-md text-[0.72rem] font-medium tracking-[0.14em] text-zinc-500",
        row: "mt-1.5 flex w-full",
        cell: "relative h-10 w-10 p-0 text-center text-sm focus-within:relative focus-within:z-20",
        day: cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "h-10 w-10 rounded-xl p-0 font-normal text-zinc-100 shadow-none hover:bg-white/[0.06] hover:text-white",
        ),
        day_selected:
          "bg-[linear-gradient(135deg,#a6f1de_0%,#7ee0d2_100%)] text-slate-950 shadow-[0_10px_30px_rgba(126,224,210,0.22)] hover:bg-[linear-gradient(135deg,#a6f1de_0%,#7ee0d2_100%)]",
        day_today: "border border-[rgba(159,232,216,0.4)] bg-white/[0.03] text-zinc-100",
        day_outside: "text-zinc-600 opacity-45",
        day_disabled: "text-zinc-700 opacity-40",
        day_hidden: "invisible",
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
