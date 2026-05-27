"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DateFilter } from "./date-filter";
import type { LogFilters, LogRole } from "./log-model";

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
  return (
    <Card>
      <CardHeader className="pb-3">
        <SectionTitle title="筛选条件" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className={
            role === "admin"
              ? "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_180px_180px_auto]"
              : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px_180px_auto]"
          }
        >
          {role === "admin" ? (
            <Input placeholder="搜索用户" value={filters.user} onChange={(e) => onFilterChange({ user: e.target.value })} />
          ) : null}
          <Input placeholder="搜索模型" value={filters.model} onChange={(e) => onFilterChange({ model: e.target.value })} />
          {role === "admin" ? (
            <Input placeholder="搜索渠道" value={filters.channel} onChange={(e) => onFilterChange({ channel: e.target.value })} />
          ) : null}
          <Input placeholder="搜索 IP" value={filters.ip} onChange={(e) => onFilterChange({ ip: e.target.value })} />
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
