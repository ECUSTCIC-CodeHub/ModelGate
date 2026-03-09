/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession } from "@/lib/client-auth";

type ModelItem = {
  id: string;
  object: "model";
};

export default function AvailableModelsPage() {
  const router = useRouter();
  const [role, setRole] = useState<"admin" | "user">("user");
  const [rows, setRows] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { toast } = useToast();

  async function load() {
    const me = await authedFetch("/api/dashboard/profile");
    if (!me.ok) {
      clearSession();
      router.push("/login");
      return;
    }

    const meData = await me.json();
    setRole(meData.user.role as "admin" | "user");

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
      subtitle="当前账号可调用的模型 ID 列表"
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0">
            <div>
              <CardTitle>模型列表</CardTitle>
              <CardDescription>{loading ? "加载中..." : `共 ${rows.length} 条`}</CardDescription>
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
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-sm">{row.id}</TableCell>
                      </TableRow>
                    ))}
                    {!loading && rows.length === 0 ? (
                      <TableRow>
                        <TableCell className="text-zinc-400">暂无可用模型</TableCell>
                      </TableRow>
                    ) : null}
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
