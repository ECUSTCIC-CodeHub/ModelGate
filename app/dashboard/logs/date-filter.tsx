"use client";

import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { CalendarIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/shared/utils";

type DateFilterProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
};

function parseDateValue(value: string) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDateValue(date?: Date) {
  return date ? format(date, "yyyy-MM-dd") : "";
}

export function DateFilter({ value, placeholder, onChange }: DateFilterProps) {
  const selected = parseDateValue(value);

  return (
    <div className="min-w-0">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "group h-10 w-full justify-start gap-2 rounded-md bg-transparent px-3 text-left font-normal shadow-none",
              !selected ? "text-[var(--color-foreground-muted)]" : "text-[var(--color-foreground)]",
            )}
          >
            <CalendarIcon className="h-4 w-4 text-[var(--color-foreground-muted)] transition-colors group-hover:text-[var(--color-foreground-secondary)]" />
            <span className="truncate">{selected ? format(selected, "yyyy-MM-dd", { locale: zhCN }) : placeholder}</span>
            {value ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onChange("");
                  }
                }}
                className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-foreground-muted)] transition hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)]"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-3" sideOffset={4}>
          <Calendar
            mode="single"
            selected={selected}
            onSelect={(date) => onChange(formatDateValue(date))}
            locale={zhCN}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
