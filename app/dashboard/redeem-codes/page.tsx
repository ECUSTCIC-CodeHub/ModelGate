"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { authedFetch } from "@/lib/auth/client-auth";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";

type ChannelOption = { id: number; name: string };
type ModelOption = { alias: string; real_model: string };

type CodeRow = {
  id: number;
  code: string;
  batch_id: string;
  token_quota: number | null;
  request_quota: number | null;
  allowed_channel_ids: string;
  allowed_model_aliases: string;
  expires_at: string | null;
  enabled: number;
  max_uses: number;
  used_count: number;
  note: string | null;
  created_at: string;
};

function parseChannelIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0) : [];
  } catch { return []; }
}

function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  } catch { return []; }
}

export default function AdminRedeemCodesPage() {
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [keyword, setKeyword] = useState("");

  const [count, setCount] = useState(10);
  const [tokenQuota, setTokenQuota] = useState("");
  const [requestQuota, setRequestQuota] = useState("");
  const [channelIds, setChannelIds] = useState<number[]>([]);
  const [aliases, setAliases] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);

  const loadCodes = useCallback(async (targetPage: number) => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String((targetPage - 1) * pageSize) });
    if (keyword) params.set("keyword", keyword);
    const res = await authedFetch(`/api/admin/redeem-codes?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data) return;
    setRows(data.data ?? []);
    setTotal(data.paging?.total ?? 0);
    setPage(targetPage);
  }, [keyword]);

  const loadOptions = useCallback(async () => {
    const [chRes, mRes] = await Promise.all([
      authedFetch("/api/admin/channels"),
      authedFetch("/api/admin/models"),
    ]);
    if (chRes.ok) {
      const data = await chRes.json().catch(() => null);
      if (data?.data) setChannels(data.data.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name })));
    }
    if (mRes.ok) {
      const data = await mRes.json().catch(() => null);
      if (data?.data) setModels(data.data.map((m: { alias: string; real_model: string }) => ({ alias: m.alias, real_model: m.real_model })));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadOptions();
      await loadCodes(1);
    })();
  }, [loadOptions, loadCodes]);

  const toggleChannel = (id: number) => {
    setChannelIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };
  const toggleAlias = (alias: string) => {
    setAliases((prev) => (prev.includes(alias) ? prev.filter((a) => a !== alias) : [...prev, alias]));
  };

  const generate = async () => {
    const payload: Record<string, unknown> = { count };
    if (tokenQuota.trim()) payload.token_quota = Number(tokenQuota);
    if (requestQuota.trim()) payload.request_quota = Number(requestQuota);
    if (channelIds.length > 0) payload.allowed_channel_ids = channelIds;
    if (aliases.length > 0) payload.allowed_model_aliases = aliases;
    if (expiresAt) payload.expires_at = new Date(expiresAt).toISOString();
    payload.max_uses = maxUses;
    if (note.trim()) payload.note = note;

    setGenerating(true);
    try {
      const res = await authedFetch("/api/admin/redeem-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error?.message ?? "生成失败");
        return;
      }
      toast.success(data?.message ?? "生成成功");
      if (data?.data?.codes?.length) {
        window.navigator.clipboard?.writeText(data.data.codes.join("\n")).catch(() => undefined);
      }
      setCount(10);
      setTokenQuota("");
      setRequestQuota("");
      setChannelIds([]);
      setAliases([]);
      setExpiresAt("");
      setMaxUses(1);
      setNote("");
      await loadCodes(1);
    } finally {
      setGenerating(false);
    }
  };

  const toggleEnabled = async (row: CodeRow) => {
    const res = await authedFetch("/api/admin/redeem-codes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: row.code, enabled: row.enabled !== 1 }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(data?.error?.message ?? "操作失败");
      return;
    }
    toast.success(data?.message ?? "操作成功");
    await loadCodes(page);
  };

  const remove = async (row: CodeRow) => {
    if (!window.confirm(`确定删除兑换码 ${row.code}？相关额度与核销记录将一并删除。`)) return;
    const res = await authedFetch(`/api/admin/redeem-codes/${row.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(data?.error?.message ?? "删除失败");
      return;
    }
    toast.success(data?.message ?? "删除成功");
    await loadCodes(page);
  };

  return (
    <DashboardShell role="admin" title="兑换码管理" subtitle="批量生成定向兑换码，限定渠道与模型，供用户兑换后获得定向额度。">
      <div className="space-y-4 pb-6">
        <Card>
          <CardHeader>
            <SectionTitle title="批量生成" description="一次生成 N 个兑换码，共享同一套渠道/模型限定与额度。生成的兑换码会复制到剪贴板。" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              <div>
                <Label>生成数量</Label>
                <Input type="number" min={1} max={500} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </div>
              <div>
                <Label>Token 额度（留空表示不限制）</Label>
                <Input type="number" min={1} value={tokenQuota} onChange={(e) => setTokenQuota(e.target.value)} placeholder="如 1000000" />
              </div>
              <div>
                <Label>请求额度（留空表示不限制）</Label>
                <Input type="number" min={1} value={requestQuota} onChange={(e) => setRequestQuota(e.target.value)} placeholder="如 1000" />
              </div>
              <div>
                <Label>有效期</Label>
                <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </div>
              <div>
                <Label>每个码最多兑换次数（0 表示不限）</Label>
                <Input type="number" min={0} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} />
              </div>
              <div>
                <Label>备注</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>限定渠道（不选表示不限制）</Label>
                <div className="mt-1 flex flex-wrap gap-2 rounded-xl border border-[var(--color-border)] p-3">
                  {channels.length === 0 ? (
                    <span className="text-xs text-[var(--color-foreground-muted)]">暂无可用渠道</span>
                  ) : (
                    channels.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleChannel(c.id)}
                        className={`rounded-full px-3 py-1 text-xs transition-colors ${channelIds.includes(c.id) ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]"}`}
                      >
                        {c.name} (#{c.id})
                      </button>
                    ))
                  )}
                </div>
              </div>
              <div>
                <Label>限定模型（不选表示不限制）</Label>
                <div className="mt-1 flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-xl border border-[var(--color-border)] p-3">
                  {models.length === 0 ? (
                    <span className="text-xs text-[var(--color-foreground-muted)]">暂无可用模型</span>
                  ) : (
                    models.map((m) => (
                      <button
                        key={m.alias}
                        type="button"
                        onClick={() => toggleAlias(m.alias)}
                        className={`rounded-full px-3 py-1 text-xs transition-colors ${aliases.includes(m.alias) ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]"}`}
                      >
                        {m.alias}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-[var(--color-foreground-muted)]">
                已选渠道：{channelIds.length} 个，已选模型：{aliases.length} 个
              </p>
              <Button onClick={() => void generate()} disabled={generating}>
                {generating ? "生成中…" : "批量生成"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <SectionTitle title="兑换码列表" description="管理已生成的兑换码，支持停用与删除。" />
              <div className="flex items-center gap-2">
                <Input
                  placeholder="搜索兑换码"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadCodes(1); }}
                  className="w-56"
                />
                <Button variant="outline" onClick={() => void loadCodes(1)}>搜索</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <Table className="min-w-[1000px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>兑换码</TableHead>
                    <TableHead>批次</TableHead>
                    <TableHead>Token 额度</TableHead>
                    <TableHead>请求额度</TableHead>
                    <TableHead>限定渠道</TableHead>
                    <TableHead>限定模型</TableHead>
                    <TableHead>有效期</TableHead>
                    <TableHead>使用</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">
                        暂无兑换码
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => {
                      const ch = parseChannelIds(row.allowed_channel_ids);
                      const al = parseAliases(row.allowed_model_aliases);
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="font-mono text-sm">{row.code}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="font-mono text-xs">{row.batch_id.slice(-8)}</Badge>
                          </TableCell>
                          <TableCell>{row.token_quota != null ? formatTokenCount(row.token_quota) : "不限"}</TableCell>
                          <TableCell>{row.request_quota != null ? formatNumber(row.request_quota) : "不限"}</TableCell>
                          <TableCell>{ch.length === 0 ? "不限" : ch.join(",")}</TableCell>
                          <TableCell>{al.length === 0 ? "不限" : al.join(",")}</TableCell>
                          <TableCell>{row.expires_at ? new Date(row.expires_at).toLocaleString() : "长期有效"}</TableCell>
                          <TableCell>{row.used_count}/{row.max_uses === 0 ? "∞" : row.max_uses}</TableCell>
                          <TableCell>
                            <Badge variant={row.enabled === 1 ? "default" : "outline"}>
                              {row.enabled === 1 ? "启用" : "停用"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button variant="outline" size="sm" onClick={() => void toggleEnabled(row)}>
                                {row.enabled === 1 ? "停用" : "启用"}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => void remove(row)}>删除</Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            <PagePagination
              page={page}
              total={total}
              pageSize={pageSize}
              label={`共 ${formatNumber(total)} 个兑换码`}
              onPageChange={(p) => void loadCodes(p)}
            />
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
