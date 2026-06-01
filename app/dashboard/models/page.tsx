"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";

type ModelItem = {
  id: string;
  object: "model";
  token_multiplier: number;
  request_multiplier: number;
};

const ENDPOINTS = [
  { label: "Chat Completions (OpenAI)", path: "/api/v1/chat/completions", method: "POST" },
  { label: "Chat (Ollama)", path: "/api/ollama/api/chat", method: "POST" },
  { label: "Responses (OpenAI)", path: "/api/v1/responses", method: "POST" },
  { label: "Messages (Anthropic Claude)", path: "/api/v1/messages", method: "POST" },
  { label: "Embeddings (OpenAI)", path: "/api/v1/embeddings", method: "POST" },
  { label: "Images Generations (OpenAI)", path: "/api/v1/images/generations", method: "POST" },
  { label: "Images Edits (OpenAI)", path: "/api/v1/images/edits", method: "POST" },
] as const;

export default function AvailableModelsPage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [role, setRole] = useState<"admin" | "user">(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
  const [rows, setRows] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const profile = await ensureLoggedIn(router);
        if (cancelled || !profile) return;
        setRole(profile.role as "admin" | "user");

        const response = await authedFetch("/api/dashboard/available-models");
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          const message = getApiMessage(data, "加载可用模型失败。");
          setError(message);
          toast({ variant: "error", description: message });
          return;
        }

        setRows(data?.data ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [router, toast]);

  function copyText(text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      toast({ variant: "success", description: "已复制到剪贴板" });
    });
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <DashboardShell
      role={role}
      title="接入指南"
      subtitle="一站式查看接入配置、协议端点与当前账号可调用的模型列表。"
    >
      <div className="space-y-4 pb-6">
        <Card>
          <CardHeader>
            <SectionTitle
              title="接入配置"
              description="将 Base URL 填入客户端配置，使用 API Key 和模型 ID 即可调用；网关同时兼容下方协议端点。"
            />
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">Base URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground)]">{origin}/api/v1</code>
                <Button type="button" variant="outline" size="sm" onClick={() => copyText(`${origin}/api/v1`)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">适用于 OpenAI SDK 等客户端的 base_url / api_base 配置项。</p>
            </div>

            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">ANTHROPIC_BASE_URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground)]">{origin}/api</code>
                <Button type="button" variant="outline" size="sm" onClick={() => copyText(`${origin}/api`)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">适用于 Anthropic SDK 等客户端的 ANTHROPIC_BASE_URL 配置项。</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">协议端点</p>
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <Table className="min-w-[600px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>协议</TableHead>
                      <TableHead>端点地址</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ENDPOINTS.map((ep) => (
                      <TableRow key={ep.path}>
                        <TableCell className="text-sm font-medium text-[var(--color-foreground)]">{ep.label}</TableCell>
                        <TableCell>
                          <code className="rounded bg-[var(--color-surface-hover)] px-2 py-1 text-xs text-[var(--color-foreground-secondary)]">{origin}{ep.path}</code>
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => copyText(`${origin}${ep.path}`)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">协议端点共用同一 API Key；模型 ID 填写对应协议可用的模型映射。</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle
              title="模型列表"
              description="模型 ID 用于请求中的 model 字段，需匹配对应协议可用的模型映射。"
            />
          </CardHeader>
          <CardContent className="space-y-4">
            {error ? <p className="text-sm text-[var(--color-destructive)]">{error}</p> : null}
            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <Table className="min-w-[460px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>模型 ID</TableHead>
                      <TableHead className="text-center">Token 倍率</TableHead>
                      <TableHead className="text-center">请求倍率</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-sm">{row.id}</TableCell>
                        <TableCell className="text-center">
                          <span className={`font-mono text-sm ${row.token_multiplier !== 1 ? "text-[var(--color-accent)] font-semibold" : "text-[var(--color-foreground-muted)]"}`}>
                            {row.token_multiplier}x
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className={`font-mono text-sm ${row.request_multiplier !== 1 ? "text-[var(--color-accent)] font-semibold" : "text-[var(--color-foreground-muted)]"}`}>
                            {row.request_multiplier}x
                          </span>
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => copyText(row.id)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
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
