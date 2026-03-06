/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession } from "@/lib/client-auth";

type KeyRow = {
  id: number;
  key: string;
  used_tokens: number;
  used_requests: number;
  enabled: number;
  created_at: string;
};

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return String(value);
}

export default function ConsoleKeysPage() {
  const router = useRouter();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<"admin" | "user">("user");
  const { toast } = useToast();

  async function load() {
    const me = await authedFetch("/api/dashboard/profile");
    if (!me.ok) {
      clearSession();
      router.push("/login");
      return;
    }

    const meData = await me.json();
    setRole(meData.user.role);

    const response = await authedFetch("/api/dashboard/keys");
    const data = await response.json();
    if (!response.ok) {
      const message = getApiMessage(data, "加载密钥列表失败。");
      setError(message);
      toast({ variant: "error", description: message });
      return;
    }
    setKeys(data.data);
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [router]);

  async function copyKey(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast({ variant: "success", description: "密钥已复制到剪贴板。" });
    } catch {
      toast({ variant: "error", description: "复制失败，请手动复制。" });
    }
  }

  async function createKey() {
    const response = await authedFetch("/api/dashboard/keys", { method: "POST", body: JSON.stringify({}) });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "创建密钥成功。") });
      if (data?.data?.key && typeof data.data.key === "string") {
        await copyKey(data.data.key);
      }
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "创建密钥失败。") });
  }

  async function toggleKey(id: number, enabled: boolean) {
    const response = await authedFetch(`/api/dashboard/keys/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新密钥成功。") });
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新密钥失败。") });
  }

  async function deleteKey(id: number) {
    const response = await authedFetch(`/api/dashboard/keys/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除密钥成功。") });
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除密钥失败。") });
  }

  return (
    <DashboardShell
      role={role}
      title="我的 API 密钥"
      subtitle="管理用于网关调用的密钥"
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>密钥列表</CardTitle>
                <CardDescription>{loading ? "加载中..." : `共 ${keys.length} 条`}</CardDescription>
              </div>
              <Button onClick={createKey}>创建密钥</Button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col px-0 pb-2 pt-0">
            {error ? <p className="px-6 pb-2 text-sm text-red-600">{error}</p> : null}
            <div className="min-h-0 flex-1 overflow-x-auto px-6">
              <div className="h-full w-full overflow-auto rounded-md border border-zinc-800">
                <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>累计请求</TableHead>
                <TableHead>累计 Token</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
                  <TableBody>
                    {keys.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.id}</TableCell>
                        <TableCell className="font-mono text-xs md:text-sm">{row.key}</TableCell>
                        <TableCell>{formatNumber(row.used_requests)}</TableCell>
                        <TableCell>{formatNumber(row.used_tokens)}</TableCell>
                        <TableCell>
                          <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
                        </TableCell>
                        <TableCell className="space-x-2 text-right">
                          <Button size="sm" variant="outline" onClick={() => void copyKey(row.key)}>
                            复制
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => toggleKey(row.id, row.enabled !== 1)}>
                            {row.enabled ? "禁用" : "启用"}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => deleteKey(row.id)}>删除</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
