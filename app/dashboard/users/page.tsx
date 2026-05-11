"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { SectionTitle } from "@/components/dashboard/section-title";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { AlertDialogAction } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, ensureAdmin } from "@/lib/client-auth";
import { formatNumber, formatLimit } from "@/lib/formatters";

type UserRow = {
  id: number;
  username: string;
  note: string | null;
  role: "admin" | "user";
  group_id: number | null;
  group_name: string | null;
  enabled: number;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  period_used_tokens: number;
  period_used_requests: number;
  period_reset_at: string | null;
  used_tokens: number;
  used_requests: number;
  allowed_model_aliases: string[];
  oidc_issuer: string | null;
  oidc_subject: string | null;
  group_rpm: number | null;
  group_qps: number | null;
  group_tpm: number | null;
  group_quota_requests: number | null;
  group_quota_tokens: number | null;
  group_quota_period: number | null;
  group_period_quota_tokens: number | null;
  group_period_quota_requests: number | null;
  effective_rpm: number;
  effective_qps: number;
  effective_tpm: number;
  effective_quota_requests: number | null;
  effective_quota_tokens: number | null;
  effective_quota_period: number | null;
  effective_period_quota_tokens: number | null;
  effective_period_quota_requests: number | null;
};

type AliasOption = {
  id: number;
  alias: string;
  is_public: number;
};

type GroupOption = {
  id: number;
  name: string;
  is_default: number;
};

type UserSortKey = "created_at" | "used_requests" | "used_tokens" | "username";

const PERIOD_PRESETS = [
  { label: "不限制（继承组）", value: "" },
  { label: "每小时", value: "3600" },
  { label: "每日", value: "86400" },
  { label: "每周", value: "604800" },
  { label: "每月", value: "2592000" },
  { label: "自定义", value: "custom" },
] as const;

function periodToPreset(v: number | null): string {
  if (v === null || v <= 0) return "";
  if (v === 3600) return "3600";
  if (v === 86400) return "86400";
  if (v === 604800) return "604800";
  if (v === 2592000) return "2592000";
  return "custom";
}

function formatPeriodLabel(v: number | null): string {
  if (v === null || v <= 0) return "-";
  if (v === 3600) return "每小时";
  if (v === 86400) return "每日";
  if (v === 604800) return "每周";
  if (v === 2592000) return "每月";
  if (v >= 86400) return `每 ${Math.round(v / 86400)} 天`;
  if (v >= 3600) return `每 ${Math.round(v / 3600)} 小时`;
  return `每 ${v} 秒`;
}

type UserForm = {
  username: string;
  password: string;
  new_password: string;
  role: "admin" | "user";
  group_id: string;
  enabled: boolean;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: string;
  quota_requests: string;
  quota_period_preset: string;
  quota_period_custom: string;
  period_quota_tokens: string;
  period_quota_requests: string;
  allowed_model_aliases: string[];
  note: string;
};

const initialForm: UserForm = {
  username: "",
  password: "",
  new_password: "",
  role: "user",
  group_id: "",
  enabled: true,
  rpm: -1,
  qps: -1,
  tpm: -1,
  quota_tokens: "",
  quota_requests: "",
  quota_period_preset: "",
  quota_period_custom: "",
  period_quota_tokens: "",
  period_quota_requests: "",
  allowed_model_aliases: [],
  note: "",
};

export default function AdminUsersPage() {
  const router = useRouter();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [form, setForm] = useState<UserForm>(initialForm);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingOidc, setEditingOidc] = useState<{ issuer: string; subject: string } | null>(null);
  const [editingGroupLimits, setEditingGroupLimits] = useState<{
    rpm: number | null; qps: number | null; tpm: number | null;
    quota_requests: number | null; quota_tokens: number | null;
    quota_period: number | null; period_quota_tokens: number | null; period_quota_requests: number | null;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<UserSortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [aliasOptions, setAliasOptions] = useState<AliasOption[]>([]);
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
  const pageSize = 20;
  const { toast } = useToast();

  async function load(
    nextPage = page,
    nextKeyword = keyword,
    nextSortBy = sortBy,
    nextSortDir = sortDir,
    nextGroupFilter = groupFilter,
  ) {
    if (!(await ensureAdmin(router))) return;
    const offset = (nextPage - 1) * pageSize;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      sort_by: nextSortBy,
      sort_dir: nextSortDir,
    });
    if (nextKeyword.trim()) params.set("keyword", nextKeyword.trim());
    if (nextGroupFilter && nextGroupFilter !== "all") params.set("group_id", nextGroupFilter);

    const response = await authedFetch(`/api/dashboard/users?${params.toString()}`);
    const data = await response.json();
    if (response.ok) {
      setRows(data.data ?? []);
      setTotal(data.paging?.total ?? 0);
      setPage(nextPage);
      setSortBy((data.sorting?.sort_by as UserSortKey) ?? nextSortBy);
      setSortDir((data.sorting?.sort_dir as "asc" | "desc") ?? nextSortDir);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const profile = await ensureAdmin(router);
      if (cancelled || !profile) return;

      const [usersRes, modelsRes, groupsRes] = await Promise.all([
        authedFetch(`/api/dashboard/users?${new URLSearchParams({ limit: String(pageSize), offset: "0", sort_by: "created_at", sort_dir: "desc" })}`),
        authedFetch("/api/dashboard/models"),
        authedFetch("/api/dashboard/groups"),
      ]);
      if (cancelled) return;

      const usersData = await usersRes.json();
      if (cancelled) return;
      if (usersRes.ok) {
        setRows(usersData.data ?? []);
        setTotal(usersData.paging?.total ?? 0);
        setPage(1);
        setSortBy((usersData.sorting?.sort_by as UserSortKey) ?? "created_at");
        setSortDir((usersData.sorting?.sort_dir as "asc" | "desc") ?? "desc");
      }

      const modelsData = await modelsRes.json().catch(() => null);
      if (cancelled) return;
      if (modelsRes.ok) {
        const modelRows = Array.isArray(modelsData?.data) ? (modelsData.data as AliasOption[]) : [];
        const unique = new Map<string, AliasOption>();
        for (const row of modelRows) {
          if (row.is_public === 1) continue;
          if (!unique.has(row.alias)) {
            unique.set(row.alias, row);
          }
        }
        setAliasOptions([...unique.values()].sort((a, b) => a.alias.localeCompare(b.alias)));
      }

      const groupsData = await groupsRes.json().catch(() => null);
      if (cancelled) return;
      if (groupsRes.ok) {
        setGroupOptions(Array.isArray(groupsData?.data) ? groupsData.data : []);
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [router]);


  function onCreateClick() {
    setEditingId(null);
    setEditingOidc(null);
    setEditingGroupLimits(null);
    setForm(initialForm);
    setDrawerOpen(true);
  }

  function onEditClick(row: UserRow) {
    setEditingId(row.id);
    setEditingOidc(row.oidc_subject ? { issuer: row.oidc_issuer ?? "", subject: row.oidc_subject } : null);
    setEditingGroupLimits(row.group_id ? {
      rpm: row.group_rpm, qps: row.group_qps, tpm: row.group_tpm,
      quota_requests: row.group_quota_requests, quota_tokens: row.group_quota_tokens,
      quota_period: row.group_quota_period, period_quota_tokens: row.group_period_quota_tokens, period_quota_requests: row.group_period_quota_requests,
    } : null);
    const preset = periodToPreset(row.quota_period);
    setForm({
      username: row.username,
      password: "",
      new_password: "",
      note: row.note ?? "",
      role: row.role,
      group_id: row.group_id !== null ? String(row.group_id) : "",
      enabled: row.enabled === 1,
      rpm: row.rpm,
      qps: row.qps,
      tpm: row.tpm,
      quota_tokens: row.quota_tokens === null ? "" : String(row.quota_tokens),
      quota_requests: row.quota_requests === null ? "" : String(row.quota_requests),
      quota_period_preset: preset,
      quota_period_custom: preset === "custom" && row.quota_period ? String(row.quota_period) : "",
      period_quota_tokens: row.period_quota_tokens === null ? "" : String(row.period_quota_tokens),
      period_quota_requests: row.period_quota_requests === null ? "" : String(row.period_quota_requests),
      allowed_model_aliases: row.allowed_model_aliases ?? [],
    });
    setDrawerOpen(true);
  }

  function toggleAllowedAlias(alias: string) {
    setForm((current) => ({
      ...current,
      allowed_model_aliases: current.allowed_model_aliases.includes(alias)
        ? current.allowed_model_aliases.filter((item) => item !== alias)
        : [...current.allowed_model_aliases, alias].sort(),
    }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    const periodValue = form.quota_period_preset === "custom"
      ? (form.quota_period_custom.trim() === "" ? null : Number(form.quota_period_custom))
      : (form.quota_period_preset === "" ? null : Number(form.quota_period_preset));

    const payload = {
      username: form.username,
      role: form.role,
      group_id: form.group_id ? Number(form.group_id) : null,
      enabled: form.enabled,
      rpm: form.rpm,
      qps: form.qps,
      tpm: form.tpm,
      quota_tokens: form.quota_tokens.trim() === "" ? null : Number(form.quota_tokens),
      quota_requests: form.quota_requests.trim() === "" ? null : Number(form.quota_requests),
      quota_period: periodValue,
      period_quota_tokens: form.period_quota_tokens.trim() === "" ? null : Number(form.period_quota_tokens),
      period_quota_requests: form.period_quota_requests.trim() === "" ? null : Number(form.period_quota_requests),
      allowed_model_aliases: form.allowed_model_aliases,
      note: form.note.trim() === "" ? null : form.note.trim(),
      ...(form.new_password.trim() ? { new_password: form.new_password.trim() } : {}),
    };

    if (editingId === null) {
      const response = await authedFetch("/api/dashboard/users", {
        method: "POST",
        body: JSON.stringify({ ...payload, password: form.password }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "创建用户成功。") });
        setDrawerOpen(false);
        setForm(initialForm);
        await load(page);
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "创建用户失败。") });
      return;
    }

    const response = await authedFetch(`/api/dashboard/users/${editingId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新用户成功。") });
      setDrawerOpen(false);
      setEditingId(null);
      setForm(initialForm);
      await load(page);
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新用户失败。") });
  }

  async function resetUsage(id: number, type: "all" | "total" | "period") {
    const response = await authedFetch(`/api/dashboard/users/${id}`, {
      method: "PUT",
      body: JSON.stringify({ reset_usage: type }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "用量已重置。") });
      await load(page);
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "重置失败。") });
  }

  async function remove(id: number) {
    const response = await authedFetch(`/api/dashboard/users/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除用户成功。") });
      const nextPage = rows.length === 1 && page > 1 ? page - 1 : page;
      await load(nextPage);
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除用户失败。") });
  }

  return (
    <DashboardShell
      role="admin"
      title="用户管理"
      subtitle="管理账号角色、启用状态、速率限制和模型访问范围。"
    >
      <div className="space-y-4 pb-6">
        <Card>
          <CardHeader>
            <SectionTitle title="用户列表" description="支持分页搜索、编辑角色与限额配置。" />
          </CardHeader>
          <CardContent className="space-y-4">
            <PageToolbar>
              <div className="grid flex-1 gap-3 md:grid-cols-[minmax(0,1fr)_160px_180px_140px_auto_auto]">
                <Input placeholder="搜索用户名" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
                <Select
                  value={groupFilter}
                  onValueChange={(value) => {
                    setGroupFilter(value);
                    void load(1, keyword, sortBy, sortDir, value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="按分组筛选" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部分组</SelectItem>
                    {groupOptions.map((g) => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        {g.name}{g.is_default ? "（默认）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={(value) => setSortBy(value as UserSortKey)}>
                  <SelectTrigger>
                    <SelectValue placeholder="排序字段" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="created_at">按创建时间</SelectItem>
                    <SelectItem value="used_requests">按累计请求</SelectItem>
                    <SelectItem value="used_tokens">按累计 Token</SelectItem>
                    <SelectItem value="username">按用户名</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sortDir} onValueChange={(value) => setSortDir(value as "asc" | "desc")}>
                  <SelectTrigger>
                    <SelectValue placeholder="排序方向" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc">降序</SelectItem>
                    <SelectItem value="asc">升序</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={() => void load(1, keyword, sortBy, sortDir, groupFilter)}>搜索</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setKeyword("");
                    setGroupFilter("all");
                    setSortBy("created_at");
                    setSortDir("desc");
                    void load(1, "", "created_at", "desc", "all");
                  }}
                >
                  重置
                </Button>
              </div>
              <Button onClick={onCreateClick}>新增用户</Button>
            </PageToolbar>

            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <Table className="min-w-[1360px] table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px]">用户名</TableHead>
                      <TableHead className="w-[180px]">标签</TableHead>
                      <TableHead className="w-[120px]">用户组</TableHead>
                      <TableHead className="w-[220px]">备注</TableHead>
                      <TableHead className="w-[180px]">限速 RPM/QPS/TPM</TableHead>
                      <TableHead className="w-[150px]">累计 请求/Token</TableHead>
                      <TableHead className="w-[150px]">配额 请求/Token</TableHead>
                      <TableHead className="w-[180px]">周期配额</TableHead>
                      <TableHead className="w-[160px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium text-[var(--color-foreground)]">
                          <span className="block truncate" title={row.username}>{row.username}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            <Badge variant={row.role === "admin" ? "default" : "secondary"}>
                              {row.role === "admin" ? "管理员" : "普通用户"}
                            </Badge>
                            <Badge variant={row.enabled ? "default" : "secondary"}>
                              {row.enabled ? "启用" : "禁用"}
                            </Badge>
                            {row.oidc_subject ? (
                              <Badge variant="outline" title={`${row.oidc_issuer}\n${row.oidc_subject}`}>OIDC</Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="block truncate text-sm text-[var(--color-foreground-secondary)]" title={row.group_name ?? ""}>
                            {row.group_name ?? "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="block truncate text-sm text-[var(--color-foreground-secondary)]" title={row.note ?? ""}>
                            {row.note?.trim() || "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className="block truncate font-mono text-sm"
                            title={`生效: ${formatLimit(row.effective_rpm)}/${formatLimit(row.effective_qps)}/${formatLimit(row.effective_tpm)}\n用户: ${formatLimit(row.rpm)}/${formatLimit(row.qps)}/${formatLimit(row.tpm)}`}
                          >
                            {formatLimit(row.effective_rpm)}/{formatLimit(row.effective_qps)}/{formatLimit(row.effective_tpm)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="block truncate font-mono text-sm" title="请求 / Token">
                            {formatNumber(row.used_requests)} / {formatNumber(row.used_tokens)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="block truncate font-mono text-sm" title="请求 / Token">
                            {row.effective_quota_requests === null ? "∞" : formatNumber(row.effective_quota_requests)}
                            {" / "}
                            {row.effective_quota_tokens === null ? "∞" : formatNumber(row.effective_quota_tokens)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {row.effective_quota_period ? (
                            <div className="space-y-0.5 text-sm">
                              <p className="font-medium text-[var(--color-foreground)]">{formatPeriodLabel(row.effective_quota_period)}</p>
                              <p className="text-xs text-[var(--color-foreground-muted)]">
                                请求 {row.effective_period_quota_requests === null ? "∞" : formatLimit(row.effective_period_quota_requests)}
                                {" / "}
                                Token {row.effective_period_quota_tokens === null ? "∞" : formatLimit(row.effective_period_quota_tokens)}
                              </p>
                              <p className="text-xs text-[var(--color-foreground-muted)]">
                                已用 {formatNumber(row.period_used_requests)} / {formatNumber(row.period_used_tokens)}
                              </p>
                            </div>
                          ) : <span className="text-sm text-[var(--color-foreground-muted)]">-</span>}
                        </TableCell>
                        <TableCell className="space-x-2 whitespace-nowrap text-right">
                          <Button size="sm" variant="outline" onClick={() => onEditClick(row)}>编辑</Button>
                          <ConfirmDialog
                            trigger={<Button size="sm" variant="outline">重置用量</Button>}
                            title={`重置用户 ${row.username} 的用量？`}
                            description="选择要重置的用量类型，重置后不可恢复。"
                            actions={<>
                              <AlertDialogAction onClick={() => resetUsage(row.id, "period")}>仅周期用量</AlertDialogAction>
                              <AlertDialogAction onClick={() => resetUsage(row.id, "total")}>仅总用量</AlertDialogAction>
                              <AlertDialogAction onClick={() => resetUsage(row.id, "all")}>全部重置</AlertDialogAction>
                            </>}
                          />
                          <ConfirmDialog
                            title={`删除用户 ${row.username}？`}
                            description="删除后该用户的登录入口会立即失效，此操作不可撤销。"
                            onConfirm={() => remove(row.id)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState title="暂无用户数据" description="当前没有匹配的用户记录，可以尝试调整搜索条件。" action={<Button onClick={onCreateClick}>新增用户</Button>} />
            )}

            <PagePagination
              page={page}
              total={total}
              pageSize={pageSize}
              label={`共 ${formatNumber(total)} 个用户`}
              onPageChange={(p) => void load(p)}
            />
          </CardContent>
        </Card>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{editingId === null ? "新增用户" : `编辑用户 #${editingId}`}</SheetTitle>
            <SheetDescription>{editingId === null ? "创建新用户账号并设置初始配额。" : "修改角色、限速、配额与模型访问权限。"}</SheetDescription>
          </SheetHeader>
          <form onSubmit={onSubmit} className="mt-4 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-sm font-medium text-[var(--color-foreground)]">基础信息</p>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>用户名</Label>
                  <Input
                    pattern="[A-Za-z0-9]+"
                    title="仅支持英文字母和数字"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                </div>
                {editingId === null ? (
                  <div className="space-y-2">
                    <Label>密码</Label>
                    <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>重置密码</Label>
                    <Input
                      type="password"
                      placeholder="留空表示不修改"
                      value={form.new_password}
                      onChange={(e) => setForm({ ...form, new_password: e.target.value })}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label>角色</Label>
                  <Select value={form.role} onValueChange={(value) => setForm({ ...form, role: value as "admin" | "user" })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">普通用户</SelectItem>
                      <SelectItem value="admin">管理员</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>状态</Label>
                  <Select value={form.enabled ? "1" : "0"} onValueChange={(value) => setForm({ ...form, enabled: value === "1" })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">启用</SelectItem>
                      <SelectItem value="0">禁用</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>用户组</Label>
                  <Select value={form.group_id} onValueChange={(value) => setForm({ ...form, group_id: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择用户组" />
                    </SelectTrigger>
                    <SelectContent>
                      {groupOptions.map((g) => (
                        <SelectItem key={g.id} value={String(g.id)}>
                          {g.name}{g.is_default ? "（默认）" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>管理员备注</Label>
                  <textarea
                    className="flex min-h-24 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
                    placeholder="仅管理员可见，可记录来源、用途、客户信息等"
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    maxLength={500}
                  />
                </div>
              </div>
            </div>

            {editingId !== null && editingOidc ? (
              <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <p className="text-sm font-medium text-[var(--color-foreground)]">OIDC 绑定</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--color-foreground-muted)]">Issuer</p>
                    <p className="truncate text-sm text-[var(--color-foreground-secondary)]" title={editingOidc.issuer}>{editingOidc.issuer}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--color-foreground-muted)]">Subject</p>
                    <p className="truncate text-sm text-[var(--color-foreground-secondary)]" title={editingOidc.subject}>{editingOidc.subject}</p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-sm font-medium text-[var(--color-foreground)]">配额配置</p>
              <p className="text-xs text-[var(--color-foreground-muted)]">`-1` 表示继承组设置（无组则不限制），`0` 表示禁止；总量配额留空表示继承组设置。</p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>RPM</Label>
                  <Input type="number" min={-1} value={form.rpm} onChange={(e) => setForm({ ...form, rpm: Number(e.target.value) })} />
                  {form.rpm < 0 && editingGroupLimits ? (
                    <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatLimit(editingGroupLimits.rpm)}</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label>QPS</Label>
                  <Input type="number" min={-1} value={form.qps} onChange={(e) => setForm({ ...form, qps: Number(e.target.value) })} />
                  {form.qps < 0 && editingGroupLimits ? (
                    <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatLimit(editingGroupLimits.qps)}</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label>TPM</Label>
                  <Input type="number" min={-1} value={form.tpm} onChange={(e) => setForm({ ...form, tpm: Number(e.target.value) })} />
                  {form.tpm < 0 && editingGroupLimits ? (
                    <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatLimit(editingGroupLimits.tpm)}</p>
                  ) : null}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>总请求配额</Label>
                  <Input type="number" min={-1} value={form.quota_requests} onChange={(e) => setForm({ ...form, quota_requests: e.target.value })} />
                  {form.quota_requests.trim() === "" && editingGroupLimits ? (
                    <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {editingGroupLimits.quota_requests === null ? "∞" : formatLimit(editingGroupLimits.quota_requests)}</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label>总 Token 配额</Label>
                  <Input type="number" min={-1} value={form.quota_tokens} onChange={(e) => setForm({ ...form, quota_tokens: e.target.value })} />
                  {form.quota_tokens.trim() === "" && editingGroupLimits ? (
                    <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {editingGroupLimits.quota_tokens === null ? "∞" : formatLimit(editingGroupLimits.quota_tokens)}</p>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                <p className="text-sm font-medium text-[var(--color-foreground)]">周期配额</p>
                <p className="mb-3 text-xs text-[var(--color-foreground-muted)]">按固定时间间隔重置用量，留空表示继承组设置。</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>重置周期</Label>
                    <Select value={form.quota_period_preset || "none"} onValueChange={(value) => setForm({ ...form, quota_period_preset: value === "none" ? "" : value, quota_period_custom: value === "custom" ? form.quota_period_custom : "" })}>
                      <SelectTrigger>
                        <SelectValue placeholder="继承组设置" />
                      </SelectTrigger>
                      <SelectContent>
                        {PERIOD_PRESETS.map((p) => (
                          <SelectItem key={p.value || "none"} value={p.value || "none"}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {form.quota_period_preset === "" && editingGroupLimits ? (
                      <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {formatPeriodLabel(editingGroupLimits.quota_period)}</p>
                    ) : null}
                  </div>
                  {form.quota_period_preset === "custom" ? (
                    <div className="space-y-2">
                      <Label>自定义周期（秒）</Label>
                      <Input type="number" min={60} value={form.quota_period_custom} onChange={(e) => setForm({ ...form, quota_period_custom: e.target.value })} placeholder="如 7200 = 2小时" />
                    </div>
                  ) : <div />}
                  <div className="space-y-2">
                    <Label>周期请求配额</Label>
                    <Input type="number" min={-1} value={form.period_quota_requests} onChange={(e) => setForm({ ...form, period_quota_requests: e.target.value })} placeholder="留空继承组设置" />
                    {form.period_quota_requests.trim() === "" && editingGroupLimits ? (
                      <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {editingGroupLimits.period_quota_requests === null ? "∞" : formatLimit(editingGroupLimits.period_quota_requests)}</p>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <Label>周期 Token 配额</Label>
                    <Input type="number" min={-1} value={form.period_quota_tokens} onChange={(e) => setForm({ ...form, period_quota_tokens: e.target.value })} placeholder="留空继承组设置" />
                    {form.period_quota_tokens.trim() === "" && editingGroupLimits ? (
                      <p className="text-xs text-[var(--color-foreground-muted)]">← 继承组: {editingGroupLimits.period_quota_tokens === null ? "∞" : formatLimit(editingGroupLimits.period_quota_tokens)}</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-sm font-medium text-[var(--color-foreground)]">额外可访问模型</p>
              <p className="text-xs text-[var(--color-foreground-muted)]">这里只展示非公开模型，用于配置额外白名单授权。</p>
              <div className="grid gap-2 md:grid-cols-2">
                {aliasOptions.map((item) => (
                  <label key={item.alias} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-3 text-sm">
                    <Checkbox
                      checked={form.allowed_model_aliases.includes(item.alias)}
                      onCheckedChange={() => toggleAllowedAlias(item.alias)}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[var(--color-foreground)]">{item.alias}</p>
                      <p className="text-xs text-[var(--color-foreground-muted)]">{item.is_public === 1 ? "公开模型" : "非公开模型"}</p>
                    </div>
                  </label>
                ))}
                {aliasOptions.length === 0 ? <p className="text-sm text-[var(--color-foreground-muted)]">暂无模型可选</p> : null}
              </div>
            </div>

            <SheetFooter>
              <Button type="button" variant="outline" onClick={() => setDrawerOpen(false)}>取消</Button>
              <Button type="submit">{editingId === null ? "创建" : "保存"}</Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </DashboardShell>
  );
}
