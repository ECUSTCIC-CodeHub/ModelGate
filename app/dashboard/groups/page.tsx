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

type GroupRow = {
  id: number;
  name: string;
  description: string | null;
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: number | null;
  quota_tokens: number | null;
  allowed_model_aliases: string[];
  is_default: number;
  enabled: number;
  user_count: number;
};

type AliasOption = {
  id: number;
  alias: string;
  is_public: number;
};

type GroupForm = {
  name: string;
  description: string;
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: string;
  quota_tokens: string;
  allowed_model_aliases: string[];
  is_default: boolean;
  enabled: boolean;
};

const initialForm: GroupForm = {
  name: "",
  description: "",
  qps: -1,
  rpm: -1,
  tpm: -1,
  quota_requests: "",
  quota_tokens: "",
  allowed_model_aliases: [],
  is_default: false,
  enabled: true,
};

function formatLimit(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 0) return "∞";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return String(value);
}

export default function AdminGroupsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [form, setForm] = useState<GroupForm>(initialForm);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [aliasOptions, setAliasOptions] = useState<AliasOption[]>([]);
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

  async function load() {
    if (!(await ensureAdmin())) return;
    const response = await authedFetch("/api/dashboard/groups?limit=100");
    const data = await response.json();
    if (response.ok) {
      setRows(data.data ?? []);
    }
  }

  async function loadAliasOptions() {
    const response = await authedFetch("/api/dashboard/models");
    const data = await response.json().catch(() => null);
    if (!response.ok) return;
    const items = Array.isArray(data?.data) ? (data.data as AliasOption[]) : [];
    const unique = new Map<string, AliasOption>();
    for (const row of items) {
      if (row.is_public === 1) continue;
      if (!unique.has(row.alias)) unique.set(row.alias, row);
    }
    setAliasOptions([...unique.values()].sort((a, b) => a.alias.localeCompare(b.alias)));
  }

  useEffect(() => {
    void Promise.all([load(), loadAliasOptions()]);
  }, [router]);

  function onCreateClick() {
    setEditingId(null);
    setForm(initialForm);
    setDrawerOpen(true);
  }

  function onEditClick(row: GroupRow) {
    setEditingId(row.id);
    setForm({
      name: row.name,
      description: row.description ?? "",
      qps: row.qps,
      rpm: row.rpm,
      tpm: row.tpm,
      quota_requests: row.quota_requests === null ? "" : String(row.quota_requests),
      quota_tokens: row.quota_tokens === null ? "" : String(row.quota_tokens),
      allowed_model_aliases: row.allowed_model_aliases ?? [],
      is_default: row.is_default === 1,
      enabled: row.enabled === 1,
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
      name: form.name,
      description: form.description.trim() || null,
      qps: form.qps,
      rpm: form.rpm,
      tpm: form.tpm,
      quota_requests: form.quota_requests.trim() === "" ? null : Number(form.quota_requests),
      quota_tokens: form.quota_tokens.trim() === "" ? null : Number(form.quota_tokens),
      allowed_model_aliases: form.allowed_model_aliases,
      is_default: form.is_default,
      enabled: form.enabled,
    };

    if (editingId === null) {
      const response = await authedFetch("/api/dashboard/groups", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "创建用户组成功。") });
        setDrawerOpen(false);
        setForm(initialForm);
        await load();
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "创建用户组失败。") });
      return;
    }

    const response = await authedFetch(`/api/dashboard/groups/${editingId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新用户组成功。") });
      setDrawerOpen(false);
      setEditingId(null);
      setForm(initialForm);
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新用户组失败。") });
  }

  async function remove(id: number) {
    const response = await authedFetch(`/api/dashboard/groups/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除用户组成功。") });
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除用户组失败。") });
  }

  return (
    <DashboardShell
      role="admin"
      title="用户组管理"
      subtitle="管理用户组及其速率限制、配额和模型访问权限。组配置作为用户的默认值生效。"
    >
      <div className="space-y-4 pb-6">
        <Card>
          <CardHeader>
            <SectionTitle title="用户组列表" description="创建和管理用户组，为用户批量配置限流和模型白名单。" />
          </CardHeader>
          <CardContent className="space-y-4">
            <PageToolbar>
              <div />
              <Button onClick={onCreateClick}>新增用户组</Button>
            </PageToolbar>

            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>组名</TableHead>
                      <TableHead>描述</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>默认</TableHead>
                      <TableHead>用户数</TableHead>
                      <TableHead>限速 (RPM/QPS/TPM)</TableHead>
                      <TableHead>请求配额</TableHead>
                      <TableHead>Token 配额</TableHead>
                      <TableHead>模型白名单</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell className="max-w-48">
                          <span className="block truncate text-zinc-300" title={row.description ?? ""}>
                            {row.description?.trim() || "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
                        </TableCell>
                        <TableCell>
                          {row.is_default ? <Badge variant="default">默认</Badge> : "-"}
                        </TableCell>
                        <TableCell>{row.user_count}</TableCell>
                        <TableCell>{formatLimit(row.rpm)}/{formatLimit(row.qps)}/{formatLimit(row.tpm)}</TableCell>
                        <TableCell>{row.quota_requests === null ? "∞" : formatLimit(row.quota_requests)}</TableCell>
                        <TableCell>{row.quota_tokens === null ? "∞" : formatLimit(row.quota_tokens)}</TableCell>
                        <TableCell className="max-w-48">
                          <span className="block truncate text-zinc-300">
                            {row.allowed_model_aliases.length > 0 ? row.allowed_model_aliases.join(", ") : "-"}
                          </span>
                        </TableCell>
                        <TableCell className="space-x-2 text-right">
                          <Button size="sm" variant="outline" onClick={() => onEditClick(row)}>编辑</Button>
                          {row.is_default ? null : (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="sm" variant="destructive">删除</Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>删除用户组 {row.name}？</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {row.user_count > 0
                                      ? `该组下仍有 ${row.user_count} 个用户，需先移除或转移用户后才能删除。`
                                      : "删除后不可恢复，此操作不可撤销。"}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>取消</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => remove(row.id)}>确认删除</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState title="暂无用户组" description="创建用户组来批量管理用户的限流和模型访问权限。" action={<Button onClick={onCreateClick}>新增用户组</Button>} />
            )}
          </CardContent>
        </Card>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{editingId === null ? "新增用户组" : `编辑用户组 #${editingId}`}</SheetTitle>
            <SheetDescription>{editingId === null ? "创建新用户组并配置限流与模型白名单。" : "修改组的限速、配额与模型访问权限。"}</SheetDescription>
          </SheetHeader>
          <form onSubmit={onSubmit} className="mt-4 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-zinc-100">基础信息</p>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>组名</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="如 default、premium、vip"
                  />
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
                  <Label>描述</Label>
                  <Input
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="组描述（可选）"
                    maxLength={200}
                  />
                </div>
                <div className="flex items-center gap-3 md:col-span-2">
                  <Checkbox
                    checked={form.is_default}
                    onCheckedChange={(checked) => setForm({ ...form, is_default: checked === true })}
                  />
                  <Label>设为默认组（新注册用户将自动加入此组）</Label>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-zinc-100">配额配置</p>
              <p className="text-xs text-zinc-500">`-1` 表示不限制。组配额作为用户的默认值，用户级设置可覆盖。</p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>RPM</Label>
                  <Input type="number" min={-1} value={form.rpm} onChange={(e) => setForm({ ...form, rpm: Number(e.target.value) })} />
                </div>
                <div className="space-y-2">
                  <Label>QPS</Label>
                  <Input type="number" min={-1} value={form.qps} onChange={(e) => setForm({ ...form, qps: Number(e.target.value) })} />
                </div>
                <div className="space-y-2">
                  <Label>TPM</Label>
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
              <p className="text-sm font-medium text-zinc-100">模型白名单</p>
              <p className="text-xs text-zinc-500">组级别的非公开模型白名单，与用户级白名单取并集。</p>
              <div className="grid gap-2 md:grid-cols-2">
                {aliasOptions.map((item) => (
                  <label key={item.alias} className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-3 text-sm">
                    <Checkbox
                      checked={form.allowed_model_aliases.includes(item.alias)}
                      onCheckedChange={() => toggleAllowedAlias(item.alias)}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-zinc-100">{item.alias}</p>
                    </div>
                  </label>
                ))}
                {aliasOptions.length === 0 ? <p className="text-sm text-zinc-500">暂无非公开模型可选</p> : null}
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
