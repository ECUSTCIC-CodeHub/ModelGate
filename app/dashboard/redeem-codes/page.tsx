"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { authedFetch } from "@/lib/auth/client-auth";
import { formatExpiresAt, formatNumber, formatTokenCount } from "@/lib/shared/utils";
import { RedeemCodeDetailDialog, useRedeemCodeDetail } from "./redeem-code-detail-dialog";
import { RedeemCodeEditDialog } from "./redeem-code-edit-dialog";
import { formatBatchLabel, formatGroupNames, parseGroupIds, redeemCodeKindLabel, type ChannelOption, type CodeRow, type GroupOption, type ModelOption, type RedeemCodeKind } from "./redeem-code-types";

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
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [keyword, setKeywordState] = useState("");
  const [batchFilter, setBatchFilterState] = useState("");
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchTotalError, setBatchTotalError] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [batchActionPending, setBatchActionPending] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [editingRow, setEditingRow] = useState<CodeRow | null>(null);
  const keywordRef = useRef("");
  const appliedKeywordRef = useRef("");
  const batchFilterRef = useRef("");
  const pageRef = useRef(1);
  const loadSeq = useRef(0);
  const batchTotalSeq = useRef(0);
  const batchActionPendingRef = useRef(false);
  const codeDetail = useRedeemCodeDetail();

  const [count, setCount] = useState(10);
  const [kind, setKind] = useState<RedeemCodeKind>("quota");
  const [tokenQuota, setTokenQuota] = useState("");
  const [requestQuota, setRequestQuota] = useState("");
  const [channelIds, setChannelIds] = useState<number[]>([]);
  const [aliases, setAliases] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);

  // 输入框内容只写 draft ref；真正生效的关键字在回车/搜索时写入 applied ref，
  // 避免「输入了但没提交」的关键字被翻页、行操作等后续 reload 静默带上。
  const setKeyword = useCallback((value: string) => {
    keywordRef.current = value;
    setKeywordState(value);
  }, []);

  const setBatchFilter = useCallback((value: string) => {
    batchFilterRef.current = value;
    setBatchFilterState(value);
  }, []);

  const loadCodes = useCallback(async (targetPage: number) => {
    const seq = ++loadSeq.current;
    pageRef.current = targetPage;
    const nextKeyword = appliedKeywordRef.current;
    const nextBatchFilter = batchFilterRef.current;
    const params = new URLSearchParams({ limit: String(pageSize), offset: String((targetPage - 1) * pageSize) });
    if (nextKeyword) params.set("keyword", nextKeyword);
    if (nextBatchFilter) params.set("batch_id", nextBatchFilter);
    setListLoading(true);
    try {
      const res = await authedFetch(`/api/admin/redeem-codes?${params.toString()}`);
      if (seq !== loadSeq.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error?.message ?? "加载兑换码失败");
        setRows([]);
        setTotal(0);
        setSelectedIds(new Set());
        return;
      }
      const data = await res.json().catch(() => null);
      if (!data || seq !== loadSeq.current) return;
      const nextTotal = typeof data.paging?.total === "number" ? data.paging.total : 0;
      setRows(data.data ?? []);
      setTotal(nextTotal);
      setPage(targetPage);
      setSelectedIds(new Set());
    } finally {
      if (seq === loadSeq.current) setListLoading(false);
    }
  }, []);

  // 批次数量单独拉一次：即使叠加关键字搜索，确认整批操作时仍以真实整批数量为准。
  const loadBatchTotal = useCallback(async (batchId: string) => {
    const seq = ++batchTotalSeq.current;
    if (!batchId) {
      setBatchTotal(0);
      setBatchLoading(false);
      setBatchTotalError(false);
      return;
    }
    setBatchLoading(true);
    setBatchTotalError(false);
    try {
      const params = new URLSearchParams({ batch_id: batchId, limit: "1", offset: "0" });
      const res = await authedFetch(`/api/admin/redeem-codes?${params.toString()}`);
      if (seq !== batchTotalSeq.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error?.message ?? "加载批次信息失败");
        setBatchTotal(0);
        setBatchTotalError(true);
        return;
      }
      const data = await res.json().catch(() => null);
      if (seq !== batchTotalSeq.current) return;
      if (!data) {
        setBatchTotal(0);
        setBatchTotalError(true);
        return;
      }
      setBatchTotal(typeof data.paging?.total === "number" ? data.paging.total : 0);
    } finally {
      if (seq === batchTotalSeq.current) setBatchLoading(false);
    }
  }, []);

  const applyKeyword = () => {
    appliedKeywordRef.current = keywordRef.current;
    setAppliedKeyword(keywordRef.current);
    void loadCodes(1);
  };

  const loadGroupOptions = useCallback(async (): Promise<{ options: GroupOption[]; failed: boolean }> => {
    const collected: GroupOption[] = [];
    let failed = false;
    let offset = 0;
    let total = 0;
    do {
      const params = new URLSearchParams({ limit: "100", offset: String(offset) });
      const res = await authedFetch(`/api/admin/groups?${params.toString()}`);
      if (!res.ok) {
        failed = true;
        break;
      }
      const data = await res.json().catch(() => null);
      const items: unknown[] = Array.isArray(data?.data) ? data.data : [];
      for (const item of items) {
        const row = item as { id?: unknown; name?: unknown; enabled?: unknown };
        if (typeof row.id !== "number" || typeof row.name !== "string") continue;
        collected.push({ id: row.id, name: row.name, enabled: typeof row.enabled === "number" ? row.enabled : 1 });
      }
      total = typeof data?.paging?.total === "number" ? data.paging.total : collected.length;
      offset += items.length;
      if (items.length === 0) break;
    } while (offset < total);
    return { options: collected, failed };
  }, []);

  const loadOptions = useCallback(async () => {
    const [chRes, mRes, groupResult] = await Promise.all([
      authedFetch("/api/admin/channels"),
      authedFetch("/api/admin/models"),
      loadGroupOptions(),
    ]);
    setGroups(groupResult.options);
    if (groupResult.failed) {
      toast.error("用户组选项加载失败，限定用户组列表可能不完整，请刷新重试");
    }
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
  }, [loadGroupOptions]);

  useEffect(() => {
    void (async () => {
      // 首屏先加载渠道/模型/用户组选项，避免列表先渲染出 #id 再被组名替换。
      await loadOptions();
      // 选项加载期间用户可能已经搜索、进入批次或翻页；此时由那次请求决定视图，
      // 首屏不要再补一次 page=1 的加载把页码重置。
      if (loadSeq.current === 0) await loadCodes(1);
    })();
  }, [loadOptions, loadCodes]);

  const toggleChannel = (id: number) => {
    setChannelIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };
  const toggleAlias = (alias: string) => {
    setAliases((prev) => (prev.includes(alias) ? prev.filter((a) => a !== alias) : [...prev, alias]));
  };
  const toggleGroup = (id: number) => {
    setGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  };

  const generate = async () => {
    const payload: Record<string, unknown> = { count, kind };
    // 重置券不发放额度，Token 额度与请求额度一律不下发。
    if (kind === "quota") {
      if (tokenQuota.trim()) payload.token_quota = Number(tokenQuota);
      if (requestQuota.trim()) payload.request_quota = Number(requestQuota);
    }
    if (channelIds.length > 0) payload.allowed_channel_ids = channelIds;
    if (aliases.length > 0) payload.allowed_model_aliases = aliases;
    if (groupIds.length > 0) payload.allowed_group_ids = groupIds;
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
      const generated = data?.data as { codes?: unknown; batch_id?: unknown } | undefined;
      const codes = Array.isArray(generated?.codes)
        ? generated.codes.filter((code): code is string => typeof code === "string")
        : [];
      const batchId = typeof generated?.batch_id === "string" ? generated.batch_id : "";
      if (codes.length > 0 && downloadAnchorRef.current) {
        downloadRedeemCodesCsv(downloadAnchorRef.current, codes, batchId);
        const copyOk = (await window.navigator.clipboard?.writeText(codes.join("\n")).then(() => true).catch(() => false)) ?? false;
        const copyHint = copyOk ? "，并已复制到剪贴板" : "；剪贴板复制失败，请从 CSV 文件获取";
        toast.success(`${data.message ?? "生成成功"}。已导出 CSV${copyHint}${batchId ? "；列表已切换到该批次" : ""}。`);
      } else {
        toast.success(data?.message ?? "生成成功");
      }
      setCount(10);
      setTokenQuota("");
      setRequestQuota("");
      setChannelIds([]);
      setAliases([]);
      setGroupIds([]);
      setExpiresAt("");
      setMaxUses(1);
      setNote("");
      if (batchId) {
        enterBatch(batchId);
      } else {
        appliedKeywordRef.current = "";
        setAppliedKeyword("");
        await loadCodes(1);
      }
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
    await loadCodes(pageRef.current);
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
    const listLoad = loadCodes(pageRef.current);
    if (batchFilterRef.current) void loadBatchTotal(batchFilterRef.current);
    await listLoad;
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

  const enterBatch = useCallback((batchId: string) => {
    appliedKeywordRef.current = "";
    setAppliedKeyword("");
    setKeyword("");
    setBatchFilter(batchId);
    setBatchTotal(0);
    setBatchTotalError(false);
    setBatchLoading(true);
    void loadBatchTotal(batchId);
    void loadCodes(1);
  }, [loadBatchTotal, loadCodes, setBatchFilter, setKeyword]);

  const clearBatchFilter = () => {
    batchTotalSeq.current += 1;
    appliedKeywordRef.current = "";
    setAppliedKeyword("");
    setKeyword("");
    setBatchFilter("");
    setBatchTotal(0);
    setBatchTotalError(false);
    setBatchLoading(false);
    void loadCodes(1);
  };

  const copyBatchId = async (batchId: string) => {
    const copied = (await navigator.clipboard?.writeText(batchId).then(() => true).catch(() => false)) ?? false;
    if (copied) toast.success("批次号已复制。");
    else toast.error("复制失败，请手动选择批次号。");
  };

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
    await loadCodes(pageRef.current);
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
    const listLoad = loadCodes(pageRef.current);
    if (batchFilterRef.current) void loadBatchTotal(batchFilterRef.current);
    await listLoad;
  };

  // 按批次操作不受当前分页与关键字影响：目标始终是整批，确认文案里的数量用 batchTotal。
  const batchToggleByBatch = async (enabled: boolean) => {
    const batchId = batchFilterRef.current;
    if (!batchId || batchTotal === 0 || batchActionPendingRef.current) return;
    const hint = enabled
      ? "启用后该批次兑换码恢复可兑换，未过期且未用尽的定向额度同时恢复。"
      : "停用后该批次兑换码立即不可兑换，已发放但未用完的定向额度同时失效；核销记录保留，可重新启用。";
    if (!window.confirm(`确定${enabled ? "启用" : "停用"}批次 ${formatBatchLabel(batchId)} 的 ${formatNumber(batchTotal)} 个兑换码？${hint}`)) return;
    batchActionPendingRef.current = true;
    setBatchActionPending(true);
    try {
      const res = await authedFetch("/api/admin/redeem-codes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch_id: batchId, enabled }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error?.message ?? "操作失败");
        return;
      }
      toast.success(data?.message ?? "操作成功");
      await loadCodes(pageRef.current);
    } finally {
      batchActionPendingRef.current = false;
      setBatchActionPending(false);
      if (batchFilterRef.current === batchId) void loadBatchTotal(batchId);
    }
  };

  const batchRemoveByBatch = async () => {
    const batchId = batchFilterRef.current;
    if (!batchId || batchTotal === 0 || batchActionPendingRef.current) return;
    if (!window.confirm(`确定删除批次 ${formatBatchLabel(batchId)} 的 ${formatNumber(batchTotal)} 个兑换码？相关定向额度与核销记录将一并删除，操作不可恢复。`)) return;
    batchActionPendingRef.current = true;
    setBatchActionPending(true);
    try {
      const res = await authedFetch("/api/admin/redeem-codes", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch_id: batchId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error?.message ?? "删除失败");
        return;
      }
      toast.success(data?.message ?? "删除成功");
      if (batchFilterRef.current === batchId) {
        batchTotalSeq.current += 1;
        appliedKeywordRef.current = "";
        setAppliedKeyword("");
        setKeyword("");
        setBatchFilter("");
        setBatchTotal(0);
        setBatchTotalError(false);
        setBatchLoading(false);
        await loadCodes(1);
      } else {
        await loadCodes(pageRef.current);
      }
    } finally {
      batchActionPendingRef.current = false;
      setBatchActionPending(false);
      if (batchFilterRef.current === batchId) void loadBatchTotal(batchId);
    }
  };

  return (
    <DashboardShell role="admin" title="兑换码管理" subtitle="批量生成定向兑换码，限定渠道与模型，供用户兑换后获得定向额度或重置周期用量。">
      <div className="space-y-4 pb-6">
        <a ref={downloadAnchorRef} className="hidden" aria-hidden="true" />
        <Card>
          <CardHeader>
            <SectionTitle title="批量生成" description="一次生成 N 个兑换码，共享同一套渠道/模型限定与额度。生成的兑换码会复制到剪贴板。" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              <div>
                <Label>类型</Label>
                <Select value={kind} onValueChange={(value) => setKind(value === "reset" ? "reset" : "quota")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="quota">额度券</SelectItem>
                    <SelectItem value="reset">重置券</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>生成数量</Label>
                <Input type="number" min={1} max={1000} value={count} onChange={(e) => setCount(Number(e.target.value))} />
                <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">单批最多 1000 个</p>
              </div>
              {kind === "quota" ? (
                <>
                  <div>
                    <Label>Token 额度（留空表示不限制）</Label>
                    <Input type="number" min={1} value={tokenQuota} onChange={(e) => setTokenQuota(e.target.value)} placeholder="如 1000000" />
                  </div>
                  <div>
                    <Label>请求额度（留空表示不限制）</Label>
                    <Input type="number" min={1} value={requestQuota} onChange={(e) => setRequestQuota(e.target.value)} placeholder="如 1000" />
                  </div>
                </>
              ) : null}
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

            {kind === "reset" ? (
              <p className="rounded-xl border border-[var(--color-border)] p-3 text-xs text-[var(--color-foreground-muted)]">
                重置券不发放任何额度，兑换后只会把兑换人的周期用量清零，让周期额度重新起算。
              </p>
            ) : null}

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
              <div className="md:col-span-2">
                <Label>限定用户组（不选表示不限）</Label>
                <div className="mt-1 flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-xl border border-[var(--color-border)] p-3">
                  {groups.length === 0 ? (
                    <span className="text-xs text-[var(--color-foreground-muted)]">暂无可用用户组</span>
                  ) : (
                    groups.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => toggleGroup(g.id)}
                        className={`rounded-full px-3 py-1 text-xs transition-colors ${groupIds.includes(g.id) ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]"}`}
                      >
                        {g.name}{g.enabled === 0 ? "（已停用）" : ""}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--color-foreground-muted)]">
                已选渠道：{channelIds.length} 个，已选模型：{aliases.length} 个，已选用户组：{groupIds.length} 个
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
              <SectionTitle title="兑换码列表" description="管理已生成的兑换码，支持详情、编辑、停用与删除。" />
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
                  placeholder={batchFilter ? "在批次内搜索兑换码" : "搜索兑换码"}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") applyKeyword(); }}
                  className="w-full sm:w-56"
                />
                <Button variant="outline" onClick={applyKeyword}>搜索</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {batchFilter ? (
              <div className="space-y-2 rounded-xl border border-[var(--color-border)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-[var(--color-foreground-muted)]">当前批次</span>
                  <span className="break-all font-mono text-xs">{batchFilter}</span>
                  <span className="text-xs text-[var(--color-foreground-muted)]">{formatBatchLabel(batchFilter)}</span>
                  <Badge variant={batchTotalError ? "destructive" : "outline"}>
                    {batchLoading
                      ? "加载中…"
                      : batchTotalError
                        ? "批次数量加载失败"
                        : batchTotal > 0
                          ? `本批 ${formatNumber(batchTotal)} 个`
                          : "批次为空"}
                  </Badge>
                  {!batchLoading && !listLoading && !batchTotalError && appliedKeyword && batchTotal !== total ? (
                    <span className="text-xs text-[var(--color-foreground-muted)]">当前筛选 {formatNumber(total)} 个</span>
                  ) : null}
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => void copyBatchId(batchFilter)}>复制批次号</Button>
                    <Button variant="outline" size="sm" disabled={batchLoading || batchTotalError || batchTotal === 0 || batchActionPending} onClick={() => void batchToggleByBatch(false)}>停用整批</Button>
                    <Button variant="outline" size="sm" disabled={batchLoading || batchTotalError || batchTotal === 0 || batchActionPending} onClick={() => void batchToggleByBatch(true)}>启用整批</Button>
                    <Button variant="ghost" size="sm" disabled={batchLoading || batchTotalError || batchTotal === 0 || batchActionPending} onClick={() => void batchRemoveByBatch()}>删除整批</Button>
                    <Button variant="ghost" size="sm" onClick={clearBatchFilter}>退出批次筛选</Button>
                  </div>
                </div>
                <p className="text-xs text-[var(--color-foreground-muted)]">
                  停用即召回：整批码立即不可兑换，已发放但未用完的定向额度同时失效；核销记录保留，可重新启用。删除会连带清除额度与核销记录，不可恢复。
                </p>
              </div>
            ) : null}
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <Table className="min-w-[1100px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="全选当前页" />
                    </TableHead>
                    <TableHead>兑换码</TableHead>
                    <TableHead>批次</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>Token 额度</TableHead>
                    <TableHead>请求额度</TableHead>
                    <TableHead>剩余额度</TableHead>
                    <TableHead>限定渠道</TableHead>
                    <TableHead>限定模型</TableHead>
                    <TableHead>限定用户组</TableHead>
                    <TableHead>有效期</TableHead>
                    <TableHead>持有/兑换</TableHead>
                    <TableHead>创建人</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={15} className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">
                        {listLoading ? "加载中…" : "暂无兑换码"}
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => {
                      const ch = parseChannelIds(row.allowed_channel_ids);
                      const al = parseAliases(row.allowed_model_aliases);
                      const gp = formatGroupNames(parseGroupIds(row.allowed_group_ids), groups);
                      const isReset = row.kind === "reset";
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
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => enterBatch(row.batch_id)}
                                title={`按批次筛选：${row.batch_id}`}
                                className={`inline-flex cursor-pointer items-center whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/35 ${batchFilter === row.batch_id ? "border-[var(--color-accent)]/20 bg-[var(--color-accent-muted)] text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)]"}`}
                              >
                                {formatBatchLabel(row.batch_id)}
                              </button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => void copyBatchId(row.batch_id)}
                                aria-label={`复制批次号 ${row.batch_id}`}
                                title="复制批次号"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={isReset ? "secondary" : "default"}>{redeemCodeKindLabel(row.kind)}</Badge>
                          </TableCell>
                          {isReset ? (
                            <TableCell colSpan={3} className="text-xs text-[var(--color-foreground-muted)]">
                              周期重置（不发放额度）
                            </TableCell>
                          ) : (
                            <>
                              <TableCell>{row.token_quota != null ? formatTokenCount(row.token_quota) : "不限"}</TableCell>
                              <TableCell>{row.request_quota != null ? formatNumber(row.request_quota) : "不限"}</TableCell>
                              <TableCell className="whitespace-nowrap text-xs">
                                {row.token_quota == null ? "Token 不限" : `Token ${formatTokenCount(Math.max(0, row.token_quota - row.used_tokens_sum))}`}
                                <br />
                                {row.request_quota == null ? "请求不限" : `请求 ${formatNumber(Math.max(0, row.request_quota - row.used_requests_sum))}`}
                              </TableCell>
                            </>
                          )}
                          <TableCell>{ch.length === 0 ? "不限" : ch.join(",")}</TableCell>
                          <TableCell>{al.length === 0 ? "不限" : al.join(",")}</TableCell>
                          <TableCell>{gp}</TableCell>
                          <TableCell>{formatExpiresAt(row.expires_at)}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {formatNumber(row.redeemed_users)} 人有效持有
                            <br />
                            {row.used_count}/{row.max_uses === 0 ? "∞" : row.max_uses} 次
                          </TableCell>
                          <TableCell>{row.created_by_username ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant={row.enabled === 1 ? "default" : "outline"}>
                              {row.enabled === 1 ? "启用" : "停用"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button variant="ghost" size="sm" onClick={() => codeDetail.openDetail(row.id)}>详情</Button>
                              <Button variant="ghost" size="sm" onClick={() => setEditingRow(row)}>编辑</Button>
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

        {codeDetail.detailId !== null ? (
          <RedeemCodeDetailDialog
            codeId={codeDetail.detailId}
            detail={codeDetail.detail}
            groups={groups}
            page={codeDetail.detailPage}
            loading={codeDetail.loadingDetail}
            onPageChange={codeDetail.changeDetailPage}
            onClose={codeDetail.closeDetail}
          />
        ) : null}
        {editingRow ? (
          <RedeemCodeEditDialog
            key={editingRow.id}
            row={editingRow}
            groups={groups}
            onClose={() => setEditingRow(null)}
            onSaved={() => void loadCodes(pageRef.current)}
          />
        ) : null}
      </div>
    </DashboardShell>
  );
}
