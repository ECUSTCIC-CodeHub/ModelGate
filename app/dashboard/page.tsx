"use client";

import { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authedFetch, clearSession, getSession } from "@/lib/client-auth";

type Role = "admin" | "user";

type Summary = {
  total_requests: number;
  total_tokens: number;
  failed_requests: number;
  total_keys: number;
  active_users: number;
};

export default function DashboardHomePage() {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<Role>("user");
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    const session = getSession();
    if (!session) {
      window.location.href = "/login";
      return;
    }

    void authedFetch("/api/dashboard/profile")
      .then(async (res) => {
        if (!res.ok) {
          clearSession();
          window.location.href = "/login";
          return;
        }
        const me = await res.json();
        setRole(me.user.role as Role);

        const summaryResp = await authedFetch("/api/dashboard/summary");
        if (summaryResp.ok) {
          const summaryData = await summaryResp.json();
          setSummary(summaryData.data ?? null);
        }
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  const isAdmin = role === "admin";

  return (
    <DashboardShell role={role} title="欢迎" subtitle="控制台总览与快捷入口">
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-5">
          <Card><CardHeader><CardDescription>总请求数</CardDescription><CardTitle>{summary?.total_requests ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>失败请求数</CardDescription><CardTitle>{summary?.failed_requests ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>总 Token</CardDescription><CardTitle>{summary?.total_tokens ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>密钥数</CardDescription><CardTitle>{summary?.total_keys ?? 0}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>{isAdmin ? "活跃用户" : "我的角色"}</CardDescription><CardTitle>{isAdmin ? (summary?.active_users ?? 0) : "普通用户"}</CardTitle></CardHeader></Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>快捷操作</CardTitle>
            <CardDescription>常用功能一键进入</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Button onClick={() => (window.location.href = "/dashboard/keys")}>新建/管理 Key</Button>
            <Button variant="outline" onClick={() => (window.location.href = "/dashboard/logs")}>查看日志</Button>
            <Button variant="outline" onClick={() => (window.location.href = "/dashboard/profile")}>个人资料</Button>
            {isAdmin ? <Button variant="outline" onClick={() => (window.location.href = "/dashboard/channels")}>渠道管理</Button> : null}
            {isAdmin ? <Button variant="outline" onClick={() => (window.location.href = "/dashboard/users")}>用户管理</Button> : null}
            {isAdmin ? <Button variant="outline" onClick={() => (window.location.href = "/dashboard/settings")}>系统设置</Button> : null}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
