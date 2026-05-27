"use client";

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

export function DashboardSummaryCards({ loading, role, summary }: DashboardSummaryCardsProps) {
  const isAdmin = role === "admin";
  const statCards = [
    {
      label: "总请求数",
      value: loading ? "-" : formatNumber(summary?.total_requests),
      hint: "累计请求总量",
      icon: Activity,
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
      hint: isAdmin ? "最近有请求的用户数" : "当前登录权限",
      icon: isAdmin ? Users : ShieldCheck,
    },
    {
      label: "成功率",
      value: loading ? "-" : `${(summary?.success_rate ?? 0).toFixed(2)}%`,
      hint: summary ? `失败 ${formatNumber(summary.failed_requests)} 次` : "请求成功占比",
      icon: BadgeCheck,
    },
    {
      label: "平均响应时间",
      value: loading ? "-" : formatDuration(summary?.avg_latency_ms),
      hint: "所有请求平均耗时",
      icon: Clock3,
    },
    {
      label: "平均输出速度",
      value: loading ? "-" : `${(summary?.avg_output_tps ?? 0).toFixed(2)} token/s`,
      hint: "流式输出平均速度",
      icon: Rocket,
    },
    {
      label: "密钥数量",
      value: loading ? "-" : formatNumber(summary?.total_keys),
      hint: "当前可管理 API Key 数量",
      icon: KeyRound,
    },
    {
      label: "失败请求",
      value: loading ? "-" : formatNumber(summary?.failed_requests),
      hint: "便于快速定位异常时段",
      icon: Activity,
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
        />
      ))}
    </div>
  );
}
