/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/dashboard/empty-state";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/client-auth";

type ModelItem = {
  id: string;
  object: "model";
};

export default function AvailableModelsPage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [role, setRole] = useState<"admin" | "user">(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
  const [rows, setRows] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { toast } = useToast();

  async function load() {
    const profile = await getOrFetchProfile();
    if (!profile) {
      clearSession();
      router.replace("/login");
      return;
    }
    setRole(profile.role as "admin" | "user");

    const response = await authedFetch("/api/dashboard/available-models");
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = getApiMessage(data, "加载可用模型失败。");
      setError(message);
      toast({ variant: "error", description: message });
      return;
    }

    setRows(data?.data ?? []);
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [router]);

  return (
    <DashboardShell
      role={role}
      title="可用模型"
      subtitle="这里展示当前账号实际可调用的模型标识。"
    >
      <div className="space-y-4 pb-6">
        <div className="grid gap-4 md:grid-cols-2">
          <MetricCard label="模型数量" value={String(rows.length)} hint="当前账号可直接调用的模型数量" />
          <MetricCard label="访问方式" value="OpenAI 兼容" hint="将模型 ID 填入 model 字段即可调用" />
        </div>
        <Card>
          <CardHeader>
            <SectionTitle
              title="模型列表"
              description="模型 ID 会直接用于 OpenAI 兼容请求的 model 字段。"
            />
          </CardHeader>
          <CardContent className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <Table className="min-w-[460px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-sm">{row.id}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState
                title={loading ? "正在加载模型列表" : "暂无可用模型"}
                description={loading ? "正在读取当前账号可访问的模型。" : "请检查渠道与模型配置，或确认当前账号是否被授予模型访问权限。"}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
