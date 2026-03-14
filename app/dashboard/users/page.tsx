/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { SectionTitle } from "@/components/dashboard/section-title";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
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
import { authedFetch, clearSession, getOrFetchProfile } from "@/lib/client-auth";

type UserRow = {
  id: number;
  username: string;
  note: string | null;
  role: "admin" | "user";
  enabled: number;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
  allowed_model_aliases: string[];
};

type AliasOption = {
  id: number;
  alias: string;
  is_public: number;
};

type UserSortKey = "created_at" | "used_requests" | "used_tokens" | "username";

type UserForm = {
  username: string;
  password: string;
  new_password: string;
  role: "admin" | "user";
  enabled: boolean;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: string;
  quota_requests: string;
  allowed_model_aliases: string[];
  note: string;
};

const initialForm: UserForm = {
  username: "",
  password: "",
  new_password: "",
  role: "user",
  enabled: true,
  rpm: -1,
  qps: -1,
  tpm: -1,
  quota_tokens: "",
  quota_requests: "",
  allowed_model_aliases: [],
  note: "",
};

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return String(value);
}

function formatLimit(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 0) return "∞";
  return formatNumber(value);
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [form, setForm] = useState<UserForm>(initialForm);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [sortBy, setSortBy] = useState<UserSortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [aliasOptions, setAliasOptions] = useState<AliasOption[]>([]);
  const pageSize = 20;
  const { toast } = useToast();

  async function ensureAdmin() {
    const profile = await getOrFetchProfile();
    if (!profile) {
      clearSession();
      router.push("/login");
      return false;
    }
    if (profile.role !== "admin") {
      router.push("/dashboard/keys");
      return false;
    }
    return true;
  }

  async function load(
    nextPage = page,
    nextKeyword = keyword,
    nextSortBy = sortBy,
    nextSortDir = sortDir,
  ) {
    if (!(await ensureAdmin())) return;
    const offset = (nextPage - 1) * pageSize;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      sort_by: nextSortBy,
      sort_dir: nextSortDir,
    });
    if (nextKeyword.trim()) params.set("keyword", nextKeyword.trim());

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

  async function loadAliasOptions() {
    const response = await authedFetch("/api/dashboard/models");
    const data = await response.json().catch(() => null);
    if (!response.ok) return;

    const rows = Array.isArray(data?.data) ? (data.data as AliasOption[]) : [];
    const unique = new Map<string, AliasOption>();
    for (const row of rows) {
      if (row.is_public === 1) continue;
      if (!unique.has(row.alias)) {
        unique.set(row.alias, row);
      }
    }
    setAliasOptions([...unique.values()].sort((a, b) => a.alias.localeCompare(b.alias)));
  }

  useEffect(() => {
    void Promise.all([load(1), loadAliasOptions()]);
  }, [router]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageWindow = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 3) return [1, 2, 3, 4, 5];
    if (page >= totalPages - 2) return [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [page - 2, page - 1, page, page + 1, page + 2];
  })();

  function onCreateClick() {
    setEditingId(null);
    setForm(initialForm);
    setDrawerOpen(true);
  }

  function onEditClick(row: UserRow) {
    setEditingId(row.id);
    setForm({
      username: row.username,
      password: "",
      new_password: "",
      note: row.note ?? "",
      role: row.role,
      enabled: row.enabled === 1,
      rpm: row.rpm,
      qps: row.qps,
      tpm: row.tpm,
      quota_tokens: row.quota_tokens === null ? "" : String(row.quota_tokens),
      quota_requests: row.quota_requests === null ? "" : String(row.quota_requests),
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

    const payload = {
      username: form.username,
      role: form.role,
      enabled: form.enabled,
      rpm: form.rpm,
      qps: form.qps,
      tpm: form.tpm,
      quota_tokens: form.quota_tokens.trim() === "" ? null : Number(form.quota_tokens),
      quota_requests: form.quota_requests.trim() === "" ? null : Number(form.quota_requests),
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
              <div className="grid flex-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px_140px_auto_auto]">
                <Input placeholder="搜索用户名" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
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
                <Button variant="outline" onClick={() => void load(1, keyword, sortBy, sortDir)}>搜索</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setKeyword("");
                    setSortBy("created_at");
                    setSortDir("desc");
                    void load(1, "", "created_at", "desc");
                  }}
                >
                  重置
                </Button>
              </div>
              <Button onClick={onCreateClick}>新增用户</Button>
            </PageToolbar>

            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <Table className="min-w-[1120px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>序号</TableHead>
                      <TableHead>用户名</TableHead>
                      <TableHead>角色</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>限速</TableHead>
                      <TableHead>累计请求</TableHead>
                      <TableHead>累计 Token</TableHead>
                      <TableHead>请求配额</TableHead>
                      <TableHead>Token 配额</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, index) => (
                      <TableRow key={row.id}>
                        <TableCell>{(page - 1) * pageSize + index + 1}</TableCell>
                        <TableCell>{row.username}</TableCell>
                        <TableCell>
                          <Badge variant={row.role === "admin" ? "default" : "secondary"}>{row.role === "admin" ? "管理员" : "普通用户"}</Badge>
                        </TableCell>
                        <TableCell className="max-w-56">
                          <span className="block truncate text-zinc-300" title={row.note ?? ""}>
                            {row.note?.trim() || "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
                        </TableCell>
                        <TableCell>{formatLimit(row.rpm)}/{formatLimit(row.qps)}/{formatLimit(row.tpm)}</TableCell>
                        <TableCell>{formatNumber(row.used_requests)}</TableCell>
                        <TableCell>{formatNumber(row.used_tokens)}</TableCell>
                        <TableCell>{row.quota_requests === null ? "∞" : formatNumber(row.quota_requests)}</TableCell>
                        <TableCell>{row.quota_tokens === null ? "∞" : formatNumber(row.quota_tokens)}</TableCell>
                        <TableCell className="space-x-2 text-right">
                          <Button size="sm" variant="outline" onClick={() => onEditClick(row)}>编辑</Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="sm" variant="destructive">删除</Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>删除用户 {row.username}？</AlertDialogTitle>
                                <AlertDialogDescription>删除后该用户的登录入口会立即失效，此操作不可撤销。</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>取消</AlertDialogCancel>
                                <AlertDialogAction onClick={() => remove(row.id)}>确认删除</AlertDialogAction>
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
              <EmptyState title="暂无用户数据" description="当前没有匹配的用户记录，可以尝试调整搜索条件。" action={<Button onClick={onCreateClick}>新增用户</Button>} />
            )}

            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-zinc-400">共 {formatNumber(total)} 个用户，第 {page} / {totalPages} 页</p>
              <Pagination className="mx-0 w-auto">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious onClick={() => page > 1 && void load(page - 1)} disabled={page <= 1} />
                  </PaginationItem>
                  {pageWindow[0] > 1 ? (
                    <>
                      <PaginationItem>
                        <PaginationLink onClick={() => void load(1)} isActive={page === 1}>1</PaginationLink>
                      </PaginationItem>
                      {pageWindow[0] > 2 ? (
                        <PaginationItem>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : null}
                    </>
                  ) : null}
                  {pageWindow.map((pageNumber) => (
                    <PaginationItem key={pageNumber}>
                      <PaginationLink onClick={() => void load(pageNumber)} isActive={pageNumber === page}>
                        {pageNumber}
                      </PaginationLink>
                    </PaginationItem>
                  ))}
                  {pageWindow[pageWindow.length - 1] < totalPages ? (
                    <>
                      {pageWindow[pageWindow.length - 1] < totalPages - 1 ? (
                        <PaginationItem>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : null}
                      <PaginationItem>
                        <PaginationLink onClick={() => void load(totalPages)} isActive={page === totalPages}>
                          {totalPages}
                        </PaginationLink>
                      </PaginationItem>
                    </>
                  ) : null}
                  <PaginationItem>
                    <PaginationNext onClick={() => page < totalPages && void load(page + 1)} disabled={page >= totalPages} />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
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
            <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-zinc-100">基础信息</p>
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
                <div className="space-y-2 md:col-span-2">
                  <Label>管理员备注</Label>
                  <textarea
                    className="flex min-h-24 w-full rounded-xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-zinc-500 focus-visible:border-[rgba(159,232,216,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(159,232,216,0.18)]"
                    placeholder="仅管理员可见，可记录来源、用途、客户信息等"
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    maxLength={500}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-zinc-100">配额配置</p>
              <p className="text-xs text-zinc-500">`-1` 表示无限，`0` 表示禁止；总量配额留空表示不限制。</p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>RPM 配额</Label>
                  <Input type="number" min={-1} value={form.rpm} onChange={(e) => setForm({ ...form, rpm: Number(e.target.value) })} />
                </div>
                <div className="space-y-2">
                  <Label>QPS 配额</Label>
                  <Input type="number" min={-1} value={form.qps} onChange={(e) => setForm({ ...form, qps: Number(e.target.value) })} />
                </div>
                <div className="space-y-2">
                  <Label>TPM 配额</Label>
                  <Input type="number" min={-1} value={form.tpm} onChange={(e) => setForm({ ...form, tpm: Number(e.target.value) })} />
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>总请求配额</Label>
                  <Input type="number" min={-1} value={form.quota_requests} onChange={(e) => setForm({ ...form, quota_requests: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>总 Token 配额</Label>
                  <Input type="number" min={-1} value={form.quota_tokens} onChange={(e) => setForm({ ...form, quota_tokens: e.target.value })} />
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-zinc-100">额外可访问模型</p>
              <p className="text-xs text-zinc-500">这里只展示非公开模型，用于配置额外白名单授权。</p>
              <div className="grid gap-2 md:grid-cols-2">
                {aliasOptions.map((item) => (
                  <label key={item.alias} className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-3 text-sm">
                    <Checkbox
                      checked={form.allowed_model_aliases.includes(item.alias)}
                      onCheckedChange={() => toggleAllowedAlias(item.alias)}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-zinc-100">{item.alias}</p>
                      <p className="text-xs text-zinc-500">{item.is_public === 1 ? "公开模型" : "非公开模型"}</p>
                    </div>
                  </label>
                ))}
                {aliasOptions.length === 0 ? <p className="text-sm text-zinc-500">暂无模型可选</p> : null}
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
