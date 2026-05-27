"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  Clock3,
  Cog,
  KeyRound,
  Rocket,
  ShieldCheck,
  Sparkles,
  Users,
  Waypoints,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/dashboard/empty-state";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/auth/client-auth";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";

type Role = "admin" | "user";

type QuotaData = {
  total: {
    quota_requests: number | null;
    quota_tokens: number | null;
    used_requests: number;
    used_tokens: number;
    remaining_requests: number | null;
    remaining_tokens: number | null;
  };
  period: {
    period_seconds: number;
    period_label: string;
    quota_requests: number | null;
    quota_tokens: number | null;
    used_requests: number;
    used_tokens: number;
    remaining_requests: number | null;
    remaining_tokens: number | null;
    reset_at: string | null;
  } | null;
  rate: {
    rpm: number;
    qps: number;
    tpm: number;
  };
};

type Summary = {
  total_requests: number;
  total_tokens: number;
  failed_requests: number;
  total_keys: number;
  active_users: number;
  avg_latency_ms: number;
  avg_output_tps: number;
  retry_requests: number;
  rate_limited_requests: number;
  success_rate: number;
  estimated_peak_concurrency: number;
  estimated_avg_concurrency: number;
  hourly_tokens: Array<{ hour: string; tokens: number }>;
  top_models: Array<{ model_name: string; request_count: number; total_tokens: number }>;
  top_channels: Array<{ channel_name: string; request_count: number; total_tokens: number }>;
};

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(2)} m`;
  return `${(min / 60).toFixed(2)} h`;
}

export default function DashboardHomePage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [chartReady, setChartReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>(() => (initialProfile?.role as Role | undefined) ?? (getCachedProfile()?.role as Role | undefined) ?? "user");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [quota, setQuota] = useState<QuotaData | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    void Promise.all([getOrFetchProfile(), authedFetch("/api/dashboard/summary"), authedFetch("/api/user/quota")])
      .then(async ([profile, summaryResp, quotaResp]) => {
        if (!profile) {
          clearSession();
          router.replace("/login");
          return;
        }
        setRole(profile.role as Role);

        if (summaryResp.ok) {
          const summaryData = await summaryResp.json();
          setSummary(summaryData.data ?? null);
        }
        if (quotaResp.ok) {
          const quotaData = await quotaResp.json();
          setQuota(quotaData ?? null);
        }
      })
      .finally(() => setLoading(false));
  }, [router]);

  const topModelColumns = useMemo<Array<ColumnDef<{ model_name: string; request_count: number; total_tokens: number }>>>(
    () => [
      { accessorKey: "model_name", header: "模型" },
      { accessorKey: "request_count", header: "请求数", cell: ({ row }) => formatNumber(row.original.request_count) },
      {
        accessorKey: "total_tokens",
        header: "Token",
        cell: ({ row }) => <span title={formatNumber(row.original.total_tokens)}>{formatTokenCount(row.original.total_tokens)}</span>,
      },
    ],
    [],
  );

  const topChannelColumns = useMemo<Array<ColumnDef<{ channel_name: string; request_count: number; total_tokens: number }>>>(
    () => [
      { accessorKey: "channel_name", header: "渠道" },
      { accessorKey: "request_count", header: "请求数", cell: ({ row }) => formatNumber(row.original.request_count) },
      {
        accessorKey: "total_tokens",
        header: "Token",
        cell: ({ row }) => <span title={formatNumber(row.original.total_tokens)}>{formatTokenCount(row.original.total_tokens)}</span>,
      },
    ],
    [],
  );

  const hasQuota = quota && quota.period !== null;

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
    <DashboardShell
      role={role}
      title="首页概览"
      subtitle="查看实时请求量、成功率与 Token 消耗表现。"
      right={(
        <>
          <Button variant="outline" onClick={() => router.push("/dashboard/logs")}>查看日志</Button>
          <Button onClick={() => router.push("/dashboard/keys")}>
            <KeyRound className="h-4 w-4" />
            管理密钥
          </Button>
        </>
      )}
    >
      <div className="space-y-4 pb-6">
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

        {hasQuota ? (
          <Card>
            <CardHeader>
              <SectionTitle title="我的配额与限制" description="查看当前账户的速率限制、配额使用情况。" />
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {(quota.rate.rpm >= 0 || quota.rate.qps >= 0 || quota.rate.tpm >= 0) ? (
                  <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                    <p className="text-xs text-[var(--color-foreground-muted)]">速率限制</p>
                    <div className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-[var(--color-foreground-muted)]">RPM</span>
                        <span className="font-mono text-[var(--color-foreground)]">{quota.rate.rpm < 0 ? "∞" : formatNumber(quota.rate.rpm)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-[var(--color-foreground-muted)]">QPS</span>
                        <span className="font-mono text-[var(--color-foreground)]">{quota.rate.qps < 0 ? "∞" : formatNumber(quota.rate.qps)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-[var(--color-foreground-muted)]">TPM</span>
                        <span className="font-mono text-[var(--color-foreground)]">{quota.rate.tpm < 0 ? "∞" : formatTokenCount(quota.rate.tpm)}</span>
                      </div>
                    </div>
                  </div>
                ) : null}
                {quota.total.quota_requests !== null ? (
                  <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                    <p className="text-xs text-[var(--color-foreground-muted)]">总请求配额</p>
                    <p className="text-lg font-semibold text-[var(--color-foreground)]">
                      {formatNumber(quota.total.remaining_requests)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
                    </p>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
                      <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${Math.max(0, Math.min(100, quota.total.quota_requests > 0 ? ((quota.total.remaining_requests ?? 0) / quota.total.quota_requests) * 100 : 0))}%` }} />
                    </div>
                    <p className="text-xs text-[var(--color-foreground-muted)]">{formatNumber(quota.total.used_requests)} / {formatNumber(quota.total.quota_requests)} 已使用</p>
                  </div>
                ) : null}
                {quota.total.quota_tokens !== null ? (
                  <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                    <p className="text-xs text-[var(--color-foreground-muted)]">总 Token 配额</p>
                    <p className="text-lg font-semibold text-[var(--color-foreground)]">
                      {formatTokenCount(quota.total.remaining_tokens)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
                    </p>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
                      <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${Math.max(0, Math.min(100, quota.total.quota_tokens > 0 ? ((quota.total.remaining_tokens ?? 0) / quota.total.quota_tokens) * 100 : 0))}%` }} />
                    </div>
                    <p className="text-xs text-[var(--color-foreground-muted)]">{formatTokenCount(quota.total.used_tokens)} / {formatTokenCount(quota.total.quota_tokens)} 已使用</p>
                  </div>
                ) : null}
                {quota.period?.quota_requests !== null && quota.period ? (
                  <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                    <p className="text-xs text-[var(--color-foreground-muted)]">{quota.period.period_label}请求配额</p>
                    <p className="text-lg font-semibold text-[var(--color-foreground)]">
                      {formatNumber(quota.period.remaining_requests)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
                    </p>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
                      <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${Math.max(0, Math.min(100, quota.period.quota_requests! > 0 ? ((quota.period.remaining_requests ?? 0) / quota.period.quota_requests!) * 100 : 0))}%` }} />
                    </div>
                    <p className="text-xs text-[var(--color-foreground-muted)]">
                      {formatNumber(quota.period.used_requests)} / {formatNumber(quota.period.quota_requests)} 已使用
                      {quota.period.reset_at ? ` · 重置于 ${new Date(quota.period.reset_at).toLocaleString()}` : ""}
                    </p>
                  </div>
                ) : null}
                {quota.period?.quota_tokens !== null && quota.period ? (
                  <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                    <p className="text-xs text-[var(--color-foreground-muted)]">{quota.period.period_label} Token 配额</p>
                    <p className="text-lg font-semibold text-[var(--color-foreground)]">
                      {formatTokenCount(quota.period.remaining_tokens)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
                    </p>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
                      <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${Math.max(0, Math.min(100, quota.period.quota_tokens! > 0 ? ((quota.period.remaining_tokens ?? 0) / quota.period.quota_tokens!) * 100 : 0))}%` }} />
                    </div>
                    <p className="text-xs text-[var(--color-foreground-muted)]">
                      {formatTokenCount(quota.period.used_tokens)} / {formatTokenCount(quota.period.quota_tokens)} 已使用
                      {quota.period.reset_at ? ` · 重置于 ${new Date(quota.period.reset_at).toLocaleString()}` : ""}
                    </p>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <Card>
            <CardHeader>
              <SectionTitle
                title="最近 24 小时 Token 趋势"
                description="按小时聚合，适合观察请求高峰和成本变化。"
              />
            </CardHeader>
            <CardContent className="chart-surface h-56 lg:h-72">
              {chartReady ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart
                    accessibilityLayer={false}
                    data={summary?.hourly_tokens ?? []}
                    margin={{ top: 8, right: 12, left: 8, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                    <XAxis
                      dataKey="hour"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={20}
                      tick={{ fill: "var(--color-chart-tick)", fontSize: 11 }}
                      tickFormatter={(value: string) => value.slice(11, 16)}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={56}
                      tick={{ fill: "var(--color-chart-tick)", fontSize: 11 }}
                      tickFormatter={(value: number) => formatTokenCount(value)}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--color-chart-cursor-fill)", stroke: "var(--color-chart-cursor-stroke)", strokeWidth: 1 }}
                      contentStyle={{ background: "var(--color-chart-tooltip-bg)", border: "1px solid var(--color-chart-tooltip-border)", borderRadius: 12 }}
                      labelFormatter={(label) => String(label).replace("T", " ")}
                      formatter={(value) => {
                        const normalizedValue = Array.isArray(value) ? value[0] : value;
                        const tokenValue = typeof normalizedValue === "number" ? normalizedValue : Number(normalizedValue);
                        return [formatTokenCount(Number.isFinite(tokenValue) ? tokenValue : 0), "Token"] as const;
                      }}
                    />
                    <Bar dataKey="tokens" fill="var(--color-chart-bar)" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)]" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionTitle title="快捷入口" description="常用操作集中在这里处理。" />
            </CardHeader>
            <CardContent className="grid gap-2">
              <Button onClick={() => router.push("/dashboard/keys")}>
                <KeyRound className="h-4 w-4" />
                创建或管理 Key
              </Button>
              <Button variant="outline" onClick={() => router.push("/dashboard/logs")}>
                <Sparkles className="h-4 w-4" />
                查看请求日志
              </Button>
              <Button variant="outline" onClick={() => router.push("/dashboard/models")}>
                <ShieldCheck className="h-4 w-4" />
                查看可用模型
              </Button>
              {isAdmin ? (
                <Button variant="outline" onClick={() => router.push("/dashboard/channels")}>
                  <Waypoints className="h-4 w-4" />
                  管理接口与模型
                </Button>
              ) : null}
              {isAdmin ? (
                <Button variant="outline" onClick={() => router.push("/dashboard/users")}>
                  <Users className="h-4 w-4" />
                  用户管理
                </Button>
              ) : null}
              {isAdmin ? (
                <Button variant="outline" onClick={() => router.push("/dashboard/settings")}>
                  <Cog className="h-4 w-4" />
                  系统设置
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="min-w-0">
            <CardHeader>
              <SectionTitle title="Top 模型" description="按 Token 消耗排序。" />
            </CardHeader>
            <CardContent className="min-w-0">
              {(summary?.top_models?.length ?? 0) > 0 ? (
                <div className="max-w-full overflow-x-auto rounded-xl border border-[var(--color-border)]">
                  <DataTable columns={topModelColumns} data={summary?.top_models ?? []} tableClassName="w-full sm:min-w-[420px]" />
                </div>
              ) : (
                <EmptyState title="暂无模型数据" description="开始有请求后，这里会展示最热门模型。" />
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <SectionTitle title="Top 接口渠道" description="按 Token 消耗排序。" />
            </CardHeader>
            <CardContent className="min-w-0">
              {(summary?.top_channels?.length ?? 0) > 0 ? (
                <div className="max-w-full overflow-x-auto rounded-xl border border-[var(--color-border)]">
                  <DataTable columns={topChannelColumns} data={summary?.top_channels ?? []} tableClassName="w-full sm:min-w-[420px]" />
                </div>
              ) : (
                <EmptyState title="暂无渠道数据" description="接口接入并产生请求后，这里会显示渠道排行。" />
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </DashboardShell>
  );
}
