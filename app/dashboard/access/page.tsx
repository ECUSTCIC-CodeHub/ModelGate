"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Copy } from "lucide-react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { authedFetch, ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";

const ENDPOINTS = [
  { label: "Chat Completions (OpenAI)", path: "/api/v1/chat/completions", method: "POST" },
  { label: "Chat (Ollama)", path: "/api/ollama/api/chat", method: "POST" },
  { label: "Responses (OpenAI)", path: "/api/v1/responses", method: "POST" },
  { label: "Messages (Anthropic Claude)", path: "/api/v1/messages", method: "POST" },
  { label: "Embeddings (OpenAI)", path: "/api/v1/embeddings", method: "POST" },
  { label: "Images Generations (OpenAI)", path: "/api/v1/images/generations", method: "POST" },
  { label: "Images Edits (OpenAI)", path: "/api/v1/images/edits", method: "POST" },
  { label: "Other 通用转发（兜底）", path: "/api/v1/<path>", method: "POST" },
] as const;

export default function AccessGuidePage() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [role, setRole] = useState<"admin" | "user">(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
  const [noticeHtml, setNoticeHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    void (async () => {
      try {
        const response = await authedFetch("/api/dashboard/access-guide-notice");
        if (!response.ok) {
          console.error("加载公告失败", response.status);
          return;
        }
        const data = await response.json();
        const content = (data?.content ?? "").trim();
        if (!content) return;
        const rendered = await marked.parse(content);
        setNoticeHtml(DOMPurify.sanitize(rendered));
      } catch (err) {
        console.error("加载公告失败", err);
        toast({ variant: "error", description: "公告加载失败" });
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  useEffect(() => {
    void (async () => {
      const profile = await ensureLoggedIn(router);
      if (profile) setRole(profile.role as "admin" | "user");
    })();
  }, [router]);

  function copyText(text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      toast({ variant: "success", description: "已复制到剪贴板" });
    });
  }

  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const base = origin.replace(/\/+$/, "");

  return (
    <DashboardShell
      role={role}
      title="接入指南"
      subtitle="查看接入配置、协议端点与公告信息。"
    >
      <div className="space-y-4 pb-6">
        {loading ? (
          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="h-4 w-1/3 animate-pulse rounded bg-[var(--color-surface-hover)]" />
              <div className="h-3 w-full animate-pulse rounded bg-[var(--color-surface-hover)]" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--color-surface-hover)]" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--color-surface-hover)]" />
            </CardContent>
          </Card>
        ) : noticeHtml ? (
          <Card>
            <CardContent className="pt-6">
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: noticeHtml }}
              />
            </CardContent>
          </Card>
        ) : null}

        {origin ? (
        <Card>
          <CardHeader>
            <SectionTitle
              title="接入配置"
              description="将 Base URL 填入客户端配置，使用 API Key 和模型 ID 即可调用；网关同时兼容下方协议端点。"
            />
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">Base URL（OpenAI）</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground)]">{base}/api/v1</code>
                <Button type="button" variant="outline" size="sm" onClick={() => copyText(`${base}/api/v1`)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
              <p className="text-xs text-[var(--color-foreground-muted)]">适用于 OpenAI SDK 等客户端的 base_url / api_base 配置项。</p>
            </div>

            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--color-foreground-muted)]">ANTHROPIC_BASE_URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground)]">{base}/api</code>
                <Button type="button" variant="outline" size="sm" onClick={() => copyText(`${base}/api`)}>
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
                          <code className="rounded bg-[var(--color-surface-hover)] px-2 py-1 text-xs text-[var(--color-foreground-secondary)]">{base}{ep.path}</code>
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => copyText(`${base}${ep.path}`)}>
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
        ) : (
          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="h-4 w-1/4 animate-pulse rounded bg-[var(--color-surface-hover)]" />
              <div className="h-3 w-full animate-pulse rounded bg-[var(--color-surface-hover)]" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--color-surface-hover)]" />
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardShell>
  );
}
