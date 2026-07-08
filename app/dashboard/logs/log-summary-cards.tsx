"use client";

import { useRouter } from "next/navigation";
import { Clock3, Search, ShieldAlert, Timer, XCircle } from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import { formatDuration } from "./log-formatters";
import type { LogSummary } from "./log-model";

type LogSummaryCardsProps = {
  summary: LogSummary | null;
};

export function LogSummaryCards({ summary }: LogSummaryCardsProps) {
  const router = useRouter();
  const navigate = (params: Record<string, string>) => {
    const query = new URLSearchParams(params).toString();
    router.push(`/dashboard/logs${query ? `?${query}` : ""}`);
  };

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
      <MetricCard
        label="总请求数"
        value={formatNumber(summary?.total_requests)}
        hint="当前筛选范围内的请求量"
        icon={Search}
        onClick={() => navigate({})}
      />
      <MetricCard
        label="失败请求数"
        value={formatNumber(summary?.failed_requests)}
        hint="便于快速定位异常"
        icon={XCircle}
        onClick={() => navigate({ status: "failed" })}
      />
      <MetricCard
        label="限流请求数"
        value={formatNumber(summary?.rate_limited_requests)}
        hint="被限流的请求量"
        icon={ShieldAlert}
        onClick={() => navigate({ status: "rate_limited" })}
      />
      <MetricCard
        label="总 Token"
        value={formatTokenCount(summary?.total_tokens)}
        hint={summary
          ? `缓存命中 ${summary.cache_read_tokens ?? 0}，完整值 ${formatNumber(summary.total_tokens)}`
          : "累计 Token 消耗"}
        icon={Search}
      />
      <MetricCard
        label="平均首 Token"
        value={formatDuration(summary?.avg_first_token_latency_ms)}
        hint="首个 token 返回速度"
        icon={Timer}
      />
      <MetricCard
        label="平均输出速度"
        value={`${(summary?.avg_output_tps ?? 0).toFixed(2)} t/s`}
        hint="用于判断上游模型质量"
        icon={Clock3}
      />
    </div>
  );
}
