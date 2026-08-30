"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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

// 生成后立即导出 CSV 文件，方便批量分发（含 BOM，Excel 打开不乱码）。
// 通过组件内常驻的 <a> 元素触发下载，避免在异步回调中动态创建元素被浏览器拦截。
function downloadRedeemCodesCsv(anchor: HTMLAnchorElement, codes: string[], batchId: string) {
  const escapeCell = (value: string) => {
    // 公式注入防护：以 = + - @ 空格/制表符/回车开头的单元格强制引号包裹，Excel 打开时视为文本
    const needsQuote = /[",\n\r]/.test(value) || /^[=+\-@\t\r ]/.test(value);
    return needsQuote ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const header = "\uFEFF兑换码,批次\n";
  const rows = codes.map((code) => `${escapeCell(code)},${escapeCell(batchId)}`).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = batchId ? `兑换码-${batchId.slice(-8)}.csv` : `兑换码-${Date.now()}.csv`;
  anchor.click();
  // 下载启动是异步的，延迟到宏任务再释放 Blob URL，避免个别浏览器中断下载
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function AdminRedeemCodesPage() {
  const downloadAnchorRef = useRef<HTMLAnchorElement>(null);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

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
    setSelectedIds(new Set());
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
      if (data?.data) {
        // 同一模型别名可由多个渠道提供，/api/admin/models 会返回多行同 alias 记录；
        // 兑换码限定模型以别名维度匹配，这里过滤已禁用记录并按别名去重，避免渲染重复 key。
        const seen = new Set<string>();
        setModels(
          data.data
            .filter((m: { alias: string; enabled: number }) => {
              if (m.enabled !== 1) return false;
              if (seen.has(m.alias)) return false;
              seen.add(m.alias);
              return true;
            })
            .map((m: { alias: string; real_model: string }) => ({ alias: m.alias, real_model: m.real_model })),
        );
      }
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
      if (data?.data?.codes?.length && downloadAnchorRef.current) {
        const { codes, batch_id: rawBatchId } = data.data as { codes: string[]; batch_id?: unknown };
        const batchId = typeof rawBatchId === "string" ? rawBatchId : "";
        downloadRedeemCodesCsv(downloadAnchorRef.current, codes, batchId);
        const copyOk = (await window.navigator.clipboard?.writeText(codes.join("\n")).then(() => true).catch(() => false)) ?? false;
        toast.success(`${data.message ?? "生成成功"}。已导出 CSV${copyOk ? "，并已复制到剪贴板。" : "；剪贴板复制失败，请从 CSV 文件获取。"}`);
      } else {
        toast.success(data?.message ?? "生成成功");
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

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };

  const selectedCodes = () => rows.filter((r) => selectedIds.has(r.id)).map((r) => r.code);

  const batchToggle = async (enabled: boolean) => {
    const codes = selectedCodes();
    if (codes.length === 0) return;
    const res = await authedFetch("/api/admin/redeem-codes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codes, enabled }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(data?.error?.message ?? "操作失败");
      return;
    }
    toast.success(data?.message ?? "操作成功");
    setSelectedIds(new Set());
    await loadCodes(page);
  };

  const batchRemove = async () => {
    const codes = selectedCodes();
    if (codes.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${codes.length} 个兑换码？相关额度与核销记录将一并删除。`)) return;
    const res = await authedFetch("/api/admin/redeem-codes", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codes }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(data?.error?.message ?? "删除失败");
      return;
    }
    toast.success(data?.message ?? "删除成功");
    setSelectedIds(new Set());
    await loadCodes(page);
  };

  return (
    <DashboardShell role="admin" title="兑换码管理" subtitle="批量生成定向兑换码，限定渠道与模型，供用户兑换后获得定向额度。">
      <div className="space-y-4 pb-6">
        <a ref={downloadAnchorRef} className="hidden" aria-hidden="true" />
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

            <div className="flex flex-wrap items-center justify-between gap-2">
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
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <SectionTitle title="兑换码列表" description="管理已生成的兑换码，支持停用与删除。" />
              <div className="flex flex-wrap items-center gap-2">
                {selectedIds.size > 0 ? (
                  <>
                    <span className="text-xs text-[var(--color-foreground-muted)]">已选 {selectedIds.size} 项</span>
                    <Button variant="outline" size="sm" onClick={() => void batchToggle(true)}>批量启用</Button>
                    <Button variant="outline" size="sm" onClick={() => void batchToggle(false)}>批量停用</Button>
                    <Button variant="ghost" size="sm" onClick={() => void batchRemove()}>批量删除</Button>
                  </>
                ) : null}
                <Input
                  placeholder="搜索兑换码"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadCodes(1); }}
                  className="w-full sm:w-56"
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
                    <TableHead className="w-10">
                      <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="全选当前页" />
                    </TableHead>
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
                      <TableCell colSpan={11} className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">
                        暂无兑换码
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => {
                      const ch = parseChannelIds(row.allowed_channel_ids);
                      const al = parseAliases(row.allowed_model_aliases);
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="w-10">
                            <Checkbox
                              checked={selectedIds.has(row.id)}
                              onCheckedChange={() => toggleSelect(row.id)}
                              aria-label={`选择兑换码 ${row.code}`}
                            />
                          </TableCell>
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
