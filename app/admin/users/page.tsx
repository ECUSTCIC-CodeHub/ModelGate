/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SideDrawer } from "@/components/ui/side-drawer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession } from "@/lib/client-auth";

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
};

type UserForm = {
  username: string;
  password: string;
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
  role: "user",
  enabled: true,
  rpm: 0,
  qps: 0,
  tpm: 0,
  quota_tokens: "",
  quota_requests: "",
};

export default function AdminUsersPage() {
  const router = useRouter();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [form, setForm] = useState<UserForm>(initialForm);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const { toast } = useToast();

  async function ensureAdmin() {
    const me = await authedFetch("/api/dashboard/profile");
    if (!me.ok) {
      clearSession();
      router.push("/login");
      return false;
    }
    const data = await me.json();
    if (data.user.role !== "admin") {
      router.push("/dashboard/keys");
      return false;
    }
    return true;
  }

  async function load() {
    if (!(await ensureAdmin())) return;
    const response = await authedFetch("/api/dashboard/users");
    const data = await response.json();
    if (response.ok) setRows(data.data);
  }

  useEffect(() => {
    void load();
  }, [router]);

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
        await load();
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
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新用户失败。") });
  }

  async function remove(id: number) {
    const response = await authedFetch(`/api/dashboard/users/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除用户成功。") });
      await load();
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
      <div className="flex h-full min-h-0 flex-col gap-4">
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>用户列表</CardTitle>
                <CardDescription>共 {rows.length} 条</CardDescription>
              </div>
              <Button onClick={onCreateClick}>新增用户</Button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col px-0 pb-2 pt-0">
            <div className="min-h-0 flex-1 overflow-x-auto px-6">
              <div className="h-full w-full overflow-auto rounded-md border border-zinc-800">
                <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>用户名</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>限速</TableHead>
                  <TableHead>配额</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.id}</TableCell>
                        <TableCell>{row.username}</TableCell>
                        <TableCell>
                          <Badge variant={row.role === "admin" ? "default" : "secondary"}>{row.role === "admin" ? "管理员" : "普通用户"}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
                        </TableCell>
                        <TableCell>{row.rpm}/{row.qps}/{row.tpm}</TableCell>
                        <TableCell>
                          T:{row.quota_tokens ?? "-"} / R:{row.quota_requests ?? "-"}
                        </TableCell>
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
          </CardContent>
        </Card>
      </div>
      <SideDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editingId === null ? "新增用户" : `编辑用户 #${editingId}`}
        description={editingId === null ? "创建新用户账号" : "修改角色、限速与配额"}
      >
        <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-2">
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
          ) : null}
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
          <div className="space-y-2">
            <Label>RPM</Label>
            <Input type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: Number(e.target.value) })} />
          </div>
          <div className="space-y-2">
            <Label>QPS</Label>
            <Input type="number" value={form.qps} onChange={(e) => setForm({ ...form, qps: Number(e.target.value) })} />
          </div>
          <div className="space-y-2">
            <Label>TPM</Label>
            <Input type="number" value={form.tpm} onChange={(e) => setForm({ ...form, tpm: Number(e.target.value) })} />
          </div>
          <div className="space-y-2">
            <Label>总 Token 配额(可空)</Label>
            <Input value={form.quota_tokens} onChange={(e) => setForm({ ...form, quota_tokens: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>总请求配额(可空)</Label>
            <Input value={form.quota_requests} onChange={(e) => setForm({ ...form, quota_requests: e.target.value })} />
          </div>
          <div className="md:col-span-2 flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="submit">{editingId === null ? "创建" : "保存"}</Button>
          </div>
        </form>
      </SideDrawer>
    </DashboardShell>
  );
}
