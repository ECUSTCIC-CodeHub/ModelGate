/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { SideDrawer } from "@/components/ui/side-drawer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession, getOrFetchProfile } from "@/lib/client-auth";

type UserRow = {
  id: number;
  username: string;
  role: "admin" | "user";
  enabled: number;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
};

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

  async function load(nextPage = page, nextKeyword = keyword) {
    if (!(await ensureAdmin())) return;
    const offset = (nextPage - 1) * pageSize;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });
    if (nextKeyword.trim()) params.set("keyword", nextKeyword.trim());

    const response = await authedFetch(`/api/dashboard/users?${params.toString()}`);
    const data = await response.json();
    if (response.ok) {
      setRows(data.data ?? []);
      setTotal(data.paging?.total ?? 0);
      setPage(nextPage);
    }
  }

  useEffect(() => {
    void load(1);
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
      role: row.role,
      enabled: row.enabled === 1,
      rpm: row.rpm,
      qps: row.qps,
      tpm: row.tpm,
      quota_tokens: row.quota_tokens === null ? "" : String(row.quota_tokens),
      quota_requests: row.quota_requests === null ? "" : String(row.quota_requests),
    });
    setDrawerOpen(true);
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
      subtitle="管理员可增删改查用户与限制参数"
    >
      <div className="flex min-h-0 flex-col gap-4 md:h-full">
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0">
            <div className="flex flex-col gap-3">
              <div>
                <CardTitle>用户列表</CardTitle>
              </div>
              <div className="grid w-full gap-2 sm:grid-cols-2 xl:max-w-3xl xl:grid-cols-[minmax(0,1fr)_auto_auto_auto] xl:items-center">
                <Input
                  placeholder="搜索用户名"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                <Button variant="outline" className="w-full xl:w-auto" onClick={() => void load(1)}>搜索</Button>
                <Button
                  variant="ghost"
                  className="w-full xl:w-auto"
                  onClick={() => {
                    setKeyword("");
                    void load(1, "");
                  }}
                >
                  重置
                </Button>
                <Button className="w-full xl:w-auto" onClick={onCreateClick}>新增用户</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col px-0 pb-2 pt-0">
            <div className="min-h-0 flex-1 overflow-x-auto px-4 sm:px-6">
              <div className="h-full w-full overflow-auto rounded-md border border-zinc-800">
                <Table className="min-w-[1120px]">
              <TableHeader>
                <TableRow>
                  <TableHead>序号</TableHead>
                  <TableHead>用户名</TableHead>
                  <TableHead>角色</TableHead>
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
                          <Button size="sm" variant="secondary" onClick={() => remove(row.id)}>删除</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className="mt-4 px-4 sm:px-6">
              <Pagination>
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
      <SideDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editingId === null ? "新增用户" : `编辑用户 #${editingId}`}
        description={editingId === null ? "创建新用户账号" : "修改角色、限速与配额"}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
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
                  <Label>重置密码（可选）</Label>
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
                <select
                  className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as "admin" | "user" })}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>状态</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                  value={form.enabled ? "1" : "0"}
                  onChange={(e) => setForm({ ...form, enabled: e.target.value === "1" })}
                >
                  <option value="1">启用</option>
                  <option value="0">禁用</option>
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <p className="text-sm font-medium text-zinc-100">配额配置</p>
            <p className="text-xs text-zinc-500">`-1` 表示无限，`0` 表示禁止；总量配额留空也表示不限制。</p>
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
                <Label>总请求配额（可空）</Label>
                <Input
                  type="number"
                  min={-1}
                  value={form.quota_requests}
                  onChange={(e) => setForm({ ...form, quota_requests: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>总 Token 配额（可空）</Label>
                <Input
                  type="number"
                  min={-1}
                  value={form.quota_tokens}
                  onChange={(e) => setForm({ ...form, quota_tokens: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="submit">{editingId === null ? "创建" : "保存"}</Button>
          </div>
        </form>
      </SideDrawer>
    </DashboardShell>
  );
}
