"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, BadgeCheck, KeyRound, Rocket, ShieldCheck, Sparkles, Waypoints } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/client-auth";
import { formatNumber, formatTokenCount } from "@/lib/utils";

type Role = "admin" | "user";

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
  recent_logs: Array<{ id: number; model_name: string; status_code: number; total_tokens: number; latency_ms: number; created_at: string }>;
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

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    void Promise.all([getOrFetchProfile(), authedFetch("/api/dashboard/summary")])
      .then(async ([profile, summaryResp]) => {
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

  const recentLogColumns = useMemo<Array<ColumnDef<{ id: number; model_name: string; status_code: number; total_tokens: number; latency_ms: number; created_at: string }>>>(
    () => [
      { id: "serial", header: "序号", cell: ({ row }) => row.index + 1 },
      { accessorKey: "model_name", header: "模型" },
      {
        accessorKey: "status_code",
        header: "状态",
        cell: ({ row }) => (
          <Badge variant={row.original.status_code >= 400 ? "secondary" : "default"}>
            {row.original.status_code}
          </Badge>
        ),
      },
      {
        accessorKey: "total_tokens",
        header: "Token",
        cell: ({ row }) => <span title={formatNumber(row.original.total_tokens)}>{formatTokenCount(row.original.total_tokens)}</span>,
      },
      {
        accessorKey: "latency_ms",
        header: "用时",
        cell: ({ row }) => formatDuration(row.original.latency_ms),
      },
      {
        accessorKey: "created_at",
        header: "时间",
        cell: ({ row }) => new Date(row.original.created_at).toLocaleString(),
      },
    ],
    [],
  );

  const isAdmin = role === "admin";
  const statCards = [
    { label: "总请求数", value: loading ? "-" : formatNumber(summary?.total_requests), icon: Activity },
    { label: "失败请求数", value: loading ? "-" : formatNumber(summary?.failed_requests), icon: Activity },
    { label: "总 Token", value: loading ? "-" : formatTokenCount(summary?.total_tokens), icon: Sparkles, title: formatNumber(summary?.total_tokens) },
    { label: "密钥数", value: loading ? "-" : formatNumber(summary?.total_keys), icon: KeyRound },
    { label: isAdmin ? "活跃用户" : "我的角色", value: loading ? "-" : (isAdmin ? formatNumber(summary?.active_users) : "普通用户"), icon: ShieldCheck },
    { label: "成功率", value: loading ? "-" : `${(summary?.success_rate ?? 0).toFixed(2)}%`, icon: BadgeCheck },
    { label: "平均用时", value: loading ? "-" : formatDuration(summary?.avg_latency_ms), icon: Rocket },
    { label: "平均输出速度", value: loading ? "-" : `${(summary?.avg_output_tps ?? 0).toFixed(2)} token/s`, icon: Sparkles },
  ];

  return (
    <DashboardShell role={role} title="欢迎">
      <div className="min-h-0 space-y-4 overflow-y-auto pb-4 md:h-full md:pr-1">
        <section className="glass-panel overflow-hidden rounded-[30px] p-6 sm:p-7">
          <div>
            <h2 className="surface-title text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">运行概览</h2>
            <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {statCards.map((item) => (
                <div key={item.label} className="rounded-[22px] border border-white/8 bg-black/25 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm text-zinc-300">{item.label}</p>
                      <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-white" title={item.title}>
                        {item.value}
                      </p>
                    </div>
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[rgba(159,232,216,0.08)] text-[var(--accent)]">
                      <item.icon className="h-5 w-5" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>最近 24 小时 Token 消耗</CardTitle>
              <CardDescription>按小时聚合</CardDescription>
            </CardHeader>
            <CardContent className="h-64 sm:h-80 xl:h-80">
              {chartReady ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart
                    data={summary?.hourly_tokens ?? []}
                    margin={{ top: 8, right: 8, left: -24, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                    <XAxis
                      dataKey="hour"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={20}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      tickFormatter={(value: string) => value.slice(11, 16)}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      tickFormatter={(value: number) => formatTokenCount(value)}
                    />
                    <Tooltip
                      contentStyle={{ background: "rgba(8, 15, 29, 0.94)", border: "1px solid rgba(159, 232, 216, 0.16)", borderRadius: 16 }}
                      labelFormatter={(label) => String(label).replace("T", " ")}
                      formatter={(value: number | string | undefined) => [formatTokenCount(typeof value === "number" ? value : Number(value)), "Token"]}
                    />
                    <Bar dataKey="tokens" fill="url(#tokensGradient)" radius={[8, 8, 0, 0]} />
                    <defs>
                      <linearGradient id="tokensGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#9fe8d8" />
                        <stop offset="100%" stopColor="#5b8dff" />
                      </linearGradient>
                    </defs>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full rounded-2xl border border-white/8 bg-black/10" />
              )}
            </CardContent>
          </Card>
          <Card className="hidden xl:block">
            <CardHeader>
              <CardTitle>快捷操作</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button onClick={() => router.push("/dashboard/keys")}><KeyRound className="h-4 w-4" />新建/管理 Key</Button>
              <Button variant="outline" onClick={() => router.push("/dashboard/logs")}><Sparkles className="h-4 w-4" />查看日志</Button>
              <Button variant="outline" onClick={() => router.push("/dashboard/models")}><ShieldCheck className="h-4 w-4" />查看可用模型</Button>
              {isAdmin ? <Button variant="outline" onClick={() => router.push("/dashboard/channels")}><Waypoints className="h-4 w-4" />渠道管理</Button> : null}
              {isAdmin ? <Button variant="outline" onClick={() => router.push("/dashboard/users")}>用户管理</Button> : null}
              {isAdmin ? <Button variant="outline" onClick={() => router.push("/dashboard/settings")}>系统设置</Button> : null}
            </CardContent>
          </Card>
        </div>

        <div className="hidden gap-4 xl:grid xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Top 模型</CardTitle>
              <CardDescription>按 Token 消耗排序</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-black/10">
                <DataTable columns={topModelColumns} data={summary?.top_models ?? []} emptyText="暂无模型数据" tableClassName="min-w-[420px]" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top 渠道</CardTitle>
              <CardDescription>按 Token 消耗排序</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-black/10">
                <DataTable columns={topChannelColumns} data={summary?.top_channels ?? []} emptyText="暂无渠道数据" tableClassName="min-w-[420px]" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="hidden xl:block">
          <CardHeader>
            <CardTitle>最近请求</CardTitle>
            <CardDescription>最新 8 条请求记录</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full overflow-x-auto rounded-2xl border border-white/10 bg-black/10">
              <DataTable
                columns={recentLogColumns}
                data={summary?.recent_logs ?? []}
                emptyText="暂无请求数据"
                tableClassName="min-w-[820px]"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
