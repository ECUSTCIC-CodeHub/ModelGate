"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { authedFetch, clearSession, getSession } from "@/lib/client-auth";

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
  success_rate: number;
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
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<Role>("user");
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    const session = getSession();
    if (!session) {
      router.push("/login");
      return;
    }

    void Promise.all([authedFetch("/api/dashboard/profile"), authedFetch("/api/dashboard/summary")])
      .then(async ([profileResp, summaryResp]) => {
        if (!profileResp.ok) {
          clearSession();
          router.push("/login");
          return;
        }
        const me = await profileResp.json();
        setRole(me.user.role as Role);

        if (summaryResp.ok) {
          const summaryData = await summaryResp.json();
          setSummary(summaryData.data ?? null);
        }
      })
      .finally(() => setReady(true));
  }, [router]);

  const topModelColumns = useMemo<Array<ColumnDef<{ model_name: string; request_count: number; total_tokens: number }>>>(
    () => [
      { accessorKey: "model_name", header: "模型" },
      { accessorKey: "request_count", header: "请求数" },
      { accessorKey: "total_tokens", header: "Token" },
    ],
    [],
  );

  const topChannelColumns = useMemo<Array<ColumnDef<{ channel_name: string; request_count: number; total_tokens: number }>>>(
    () => [
      { accessorKey: "channel_name", header: "渠道" },
      { accessorKey: "request_count", header: "请求数" },
      { accessorKey: "total_tokens", header: "Token" },
    ],
    [],
  );

  const recentLogColumns = useMemo<Array<ColumnDef<{ id: number; model_name: string; status_code: number; total_tokens: number; latency_ms: number; created_at: string }>>>(
    () => [
      { accessorKey: "id", header: "ID" },
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
      { accessorKey: "total_tokens", header: "Token" },
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

  if (!ready) return null;
  const isAdmin = role === "admin";

  return (
    <DashboardShell role={role} title="欢迎" subtitle="控制台总览与快捷入口">
      <div className="space-y-4 pb-2">
        <div className="grid gap-4 md:grid-cols-4 xl:grid-cols-8">
          <Card><CardHeader><CardDescription>总请求数</CardDescription><CardTitle>{summary?.total_requests ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>失败请求数</CardDescription><CardTitle>{summary?.failed_requests ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>总 Token</CardDescription><CardTitle>{summary?.total_tokens ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>密钥数</CardDescription><CardTitle>{summary?.total_keys ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>{isAdmin ? "活跃用户" : "我的角色"}</CardDescription><CardTitle>{isAdmin ? (summary?.active_users ?? 0) : "普通用户"}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>成功率</CardDescription><CardTitle>{(summary?.success_rate ?? 0).toFixed(2)}%</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>平均用时</CardDescription><CardTitle>{formatDuration(summary?.avg_latency_ms)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>平均输出速度</CardDescription><CardTitle>{(summary?.avg_output_tps ?? 0).toFixed(2)} token/s</CardTitle></CardHeader></Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>最近 24 小时 Token 消耗</CardTitle>
              <CardDescription>按小时聚合</CardDescription>
            </CardHeader>
            <CardContent className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={summary?.hourly_tokens ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis
                    dataKey="hour"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "#a1a1aa", fontSize: 12 }}
                    tickFormatter={(value: string) => value.slice(11, 16)}
                  />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: "#a1a1aa", fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ background: "#0a0a0a", border: "1px solid #27272a", borderRadius: 8 }}
                    labelFormatter={(label) => String(label).replace("T", " ")}
                  />
                  <Bar dataKey="tokens" fill="#d4d4d8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>快捷操作</CardTitle>
              <CardDescription>常用功能一键进入</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button onClick={() => router.push("/dashboard/keys")}>新建/管理 Key</Button>
              <Button variant="outline" onClick={() => router.push("/dashboard/logs")}>查看日志</Button>
              <Button variant="outline" onClick={() => router.push("/dashboard/profile")}>个人资料</Button>
              {isAdmin ? <Button variant="outline" onClick={() => router.push("/dashboard/channels")}>渠道管理</Button> : null}
              {isAdmin ? <Button variant="outline" onClick={() => router.push("/dashboard/users")}>用户管理</Button> : null}
              {isAdmin ? <Button variant="outline" onClick={() => router.push("/dashboard/settings")}>系统设置</Button> : null}
              <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-400">
                本日重试请求：<span className="font-medium text-zinc-100">{summary?.retry_requests ?? 0}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Top 模型</CardTitle>
              <CardDescription>按 Token 消耗排序</CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable columns={topModelColumns} data={summary?.top_models ?? []} emptyText="暂无模型数据" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top 渠道</CardTitle>
              <CardDescription>按 Token 消耗排序</CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable columns={topChannelColumns} data={summary?.top_channels ?? []} emptyText="暂无渠道数据" />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>最近请求</CardTitle>
            <CardDescription>最新 8 条请求记录</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full overflow-x-auto rounded-md border border-zinc-800">
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
