/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/dashboard/empty-state";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/client-auth";

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
    const initialProfile = useAuthProfile();
    const [keys, setKeys] = useState<KeyRow[]>([]);
    const [error, setError] = useState("");
    const [role, setRole] = useState<"admin" | "user">(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
    const [baseUrlExample, setBaseUrlExample] = useState("HOST/api/v1");
    const { toast } = useToast();

    async function load() {
        const profile = await getOrFetchProfile();
        if (!profile) {
            clearSession();
            router.replace("/login");
            return;
        }
        setRole(profile.role);

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
        setBaseUrlExample(`${window.location.origin}/api/v1`);
        void load();
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
            title="密钥管理"
            subtitle="管理用于网关调用的 API 密钥，保持 OpenAI 兼容调用方式。"
        >
            <div className="space-y-4 pb-6">
                <div className="grid gap-4 md:grid-cols-3">
                    <MetricCard label="密钥数量" value={formatNumber(keys.length)} hint="当前账号持有的 API 密钥数量" />
                    <MetricCard label="累计请求" value={formatNumber(keys.reduce((sum, item) => sum + item.used_requests, 0))} hint="全部密钥累计请求数" />
                    <MetricCard label="累计 Token" value={formatNumber(keys.reduce((sum, item) => sum + item.used_tokens, 0))} hint="全部密钥累计 Token 使用量" />
                </div>

                <Card>
                    <CardHeader>
                        <SectionTitle
                            title="密钥列表"
                            description={`OpenAI 兼容调用时，base_url 使用 ${baseUrlExample}，api_key 使用这里创建的密钥。`}
                            action={<Button onClick={createKey}>创建密钥</Button>}
                        />
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {error ? <p className="text-sm text-red-400">{error}</p> : null}
                        {keys.length > 0 ? (
                            <div className="overflow-x-auto rounded-xl border border-white/10">
                                <Table className="min-w-[820px]">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>序号</TableHead>
                                            <TableHead>Key</TableHead>
                                            <TableHead>累计请求</TableHead>
                                            <TableHead>累计 Token</TableHead>
                                            <TableHead>状态</TableHead>
                                            <TableHead className="text-right">操作</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {keys.map((row, index) => (
                                            <TableRow key={row.id}>
                                                <TableCell>{index + 1}</TableCell>
                                                <TableCell className="max-w-[320px] font-mono text-xs md:text-sm">{row.key}</TableCell>
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
                                                    <AlertDialog>
                                                        <AlertDialogTrigger asChild>
                                                            <Button size="sm" variant="destructive">删除</Button>
                                                        </AlertDialogTrigger>
                                                        <AlertDialogContent>
                                                            <AlertDialogHeader>
                                                                <AlertDialogTitle>删除这个密钥？</AlertDialogTitle>
                                                                <AlertDialogDescription>
                                                                    删除后将无法继续使用该 Key 调用网关，此操作不可撤销。
                                                                </AlertDialogDescription>
                                                            </AlertDialogHeader>
                                                            <AlertDialogFooter>
                                                                <AlertDialogCancel>取消</AlertDialogCancel>
                                                                <AlertDialogAction onClick={() => deleteKey(row.id)}>确认删除</AlertDialogAction>
                                                            </AlertDialogFooter>
                                                        </AlertDialogContent>
                                                    </AlertDialog>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        ) : (
                            <EmptyState title="暂无密钥" description="创建首个密钥后，即可按 OpenAI 兼容格式接入网关。" action={<Button onClick={createKey}>创建密钥</Button>} />
                        )}
                    </CardContent>
                </Card>
            </div>
        </DashboardShell>
    );
}
