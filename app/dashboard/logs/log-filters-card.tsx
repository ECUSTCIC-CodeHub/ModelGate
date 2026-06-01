"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DateFilter } from "./date-filter";
import type { LogFilters, LogRole, LogStatusFilter } from "./log-model";

const STATUS_OPTIONS: Array<{ value: LogStatusFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "success", label: "成功" },
  { value: "failed", label: "失败" },
];

type LogFiltersCardProps = {
  role: LogRole;
  filters: LogFilters;
  loading: boolean;
  onFilterChange: (patch: Partial<LogFilters>) => void;
  onSearch: () => void;
  onReset: () => void;
};

export function LogFiltersCard({
  role,
  filters,
  loading,
  onFilterChange,
  onSearch,
  onReset,
}: LogFiltersCardProps) {
  const baseCols = role === "admin"
    ? "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_180px_180px_auto]"
    : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_180px_180px_auto]";

  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionTitle title="筛选条件" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={baseCols}>
          {role === "admin" ? (
            <Input placeholder="搜索用户" value={filters.user} onChange={(e) => onFilterChange({ user: e.target.value })} />
          ) : null}
          <Input placeholder="搜索模型" value={filters.model} onChange={(e) => onFilterChange({ model: e.target.value })} />
          {role === "admin" ? (
            <Input placeholder="搜索渠道" value={filters.channel} onChange={(e) => onFilterChange({ channel: e.target.value })} />
          ) : null}
          <Input placeholder="搜索密钥" value={filters.key} onChange={(e) => onFilterChange({ key: e.target.value })} />
          <Input placeholder="搜索 IP" value={filters.ip} onChange={(e) => onFilterChange({ ip: e.target.value })} />
          <select
              className="h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-sm font-medium text-[var(--color-foreground)] transition-colors duration-150 hover:border-[var(--color-border-hover)] focus-visible:border-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/25"
              value={filters.status}
              onChange={(e) => onFilterChange({ status: e.target.value as LogStatusFilter })}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
          </select>
          <DateFilter value={filters.startDate} placeholder="开始日期" onChange={(value) => onFilterChange({ startDate: value })} />
          <DateFilter value={filters.endDate} placeholder="结束日期" onChange={(value) => onFilterChange({ endDate: value })} />
          <div className="flex items-center gap-2 whitespace-nowrap xl:justify-end">
            <Button variant="outline" disabled={loading} onClick={onSearch}>查询</Button>
            <Button variant="ghost" disabled={loading} onClick={onReset}>重置</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
