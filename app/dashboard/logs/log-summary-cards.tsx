"use client";

import { Clock3, Search, Timer } from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import { formatDuration } from "./log-formatters";
import type { LogSummary } from "./log-model";

type LogSummaryCardsProps = {
  summary: LogSummary | null;
};

export function LogSummaryCards({ summary }: LogSummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
      <MetricCard label="总请求数" value={formatNumber(summary?.total_requests)} hint="当前筛选范围内的请求量" icon={Search} />
      <MetricCard label="失败请求数" value={formatNumber(summary?.failed_requests)} hint="便于快速定位异常" icon={Search} />
      <MetricCard label="总 Token" value={formatTokenCount(summary?.total_tokens)} hint={summary ? `完整值 ${formatNumber(summary.total_tokens)}` : "累计 Token 消耗"} icon={Search} />
      <MetricCard label="平均首 Token" value={formatDuration(summary?.avg_first_token_latency_ms)} hint="首个 token 返回速度" icon={Timer} />
      <MetricCard label="平均输出速度" value={`${(summary?.avg_output_tps ?? 0).toFixed(2)} t/s`} hint="用于判断上游模型质量" icon={Clock3} />
    </div>
  );
}
