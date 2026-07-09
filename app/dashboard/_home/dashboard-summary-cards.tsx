"use client";

import { useRouter } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  Clock3,
  KeyRound,
  Rocket,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import { formatDuration } from "./dashboard-formatters";
import type { Role, Summary } from "./dashboard-model";

type DashboardSummaryCardsProps = {
  loading: boolean;
  role: Role;
  summary: Summary | null;
};

function logsUrl(params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return `/dashboard/logs${query ? `?${query}` : ""}`;
}

export function DashboardSummaryCards({ loading, role, summary }: DashboardSummaryCardsProps) {
  const router = useRouter();
  const isAdmin = role === "admin";
  const navigate = (href: string) => router.push(href);

  const retention = summary?.log_retention_days ?? 0;
  const failedWindowDays = retention === 0 ? 30 : Math.min(30, retention);
  const recentWindowHint = retention === 0 ? "累计有请求的用户数" : `近 ${retention} 天活跃用户`;
  const avgWindowHint = retention === 0 ? "所有请求平均耗时" : `近 ${retention} 天平均耗时`;
  const tpsWindowHint = retention === 0 ? "流式输出平均速度" : `近 ${retention} 天流式平均速度`;

  const statCards = [
    {
      label: "总请求数",
      value: loading ? "-" : formatNumber(summary?.total_requests),
      hint: "累计请求总量",
      icon: Activity,
      onClick: () => navigate(logsUrl({})),
    },
    {
      label: "总 Token",
      value: loading ? "-" : formatTokenCount(summary?.total_tokens),
      hint: summary ? `完整值 ${formatNumber(summary.total_tokens)}` : "累计 Token 消耗",
      icon: Sparkles,
    },
    {
      label: isAdmin ? "活跃用户" : "当前角色",
      value: loading ? "-" : isAdmin ? formatNumber(summary?.active_users) : "普通用户",
      hint: isAdmin ? recentWindowHint : "当前登录权限",
      icon: isAdmin ? Users : ShieldCheck,
    },
    {
      label: "成功率",
      value: loading ? "-" : `${(summary?.success_rate ?? 0).toFixed(2)}%`,
      hint: summary ? `失败 ${formatNumber(summary.failed_requests)} 次` : "请求成功占比",
      icon: BadgeCheck,
      onClick: () => navigate(logsUrl({ status: "success" })),
    },
    {
      label: "平均响应时间",
      value: loading ? "-" : formatDuration(summary?.avg_latency_ms),
      hint: avgWindowHint,
      icon: Clock3,
    },
    {
      label: "平均输出速度",
      value: loading ? "-" : `${(summary?.avg_output_tps ?? 0).toFixed(2)} token/s`,
      hint: tpsWindowHint,
      icon: Rocket,
    },
    {
      label: "密钥数量",
      value: loading ? "-" : formatNumber(summary?.total_keys),
      hint: "当前可管理 API Key 数量",
      icon: KeyRound,
      onClick: () => navigate("/dashboard/keys"),
    },
    {
      label: "失败请求",
      value: loading ? "-" : formatNumber(summary?.recent_failed_requests),
      hint: `近 ${failedWindowDays} 天失败请求`,
      icon: Activity,
      onClick: () => navigate(logsUrl({ status: "failed" })),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {statCards.map((item) => (
        <MetricCard
          key={item.label}
          label={item.label}
          value={item.value}
          hint={item.hint}
          icon={item.icon}
          onClick={item.onClick}
        />
      ))}
    </div>
  );
}
