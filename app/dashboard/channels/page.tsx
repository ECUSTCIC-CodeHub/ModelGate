/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { FormEvent, useEffect, useState } from "react";
import { Fragment } from "react";
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

type ModelRow = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  enabled: number;
  weight: number;
};

type Channel = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  enabled: number;
  weight: number;
  timeout: number;
  models?: ModelRow[];
};

type ChannelModelDraft = {
  alias: string;
  real_model: string;
  weight: number;
  enabled: boolean;
};

type ChannelForm = {
  name: string;
  base_url: string;
  api_key: string;
  weight: number;
  timeout: number;
};

type ModelForm = {
  alias: string;
  real_model: string;
  channel_id: number;
  weight: number;
  enabled: boolean;
};

const initialChannelForm: ChannelForm = {
  name: "",
  base_url: "",
  api_key: "",
  weight: 1,
  timeout: 60,
};

const initialModelDraft: ChannelModelDraft = {
  alias: "",
  real_model: "",
  weight: 1,
  enabled: true,
};

const initialModelForm: ModelForm = {
  alias: "",
  real_model: "",
  channel_id: 0,
  weight: 1,
  enabled: true,
};

export default function AdminChannelsPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState("");
  const [expandedChannelIds, setExpandedChannelIds] = useState<number[]>([]);
  const [testingModelId, setTestingModelId] = useState<number | null>(null);

  const [channelDrawerOpen, setChannelDrawerOpen] = useState(false);
  const [channelEditingId, setChannelEditingId] = useState<number | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelForm>(initialChannelForm);
  const [channelModels, setChannelModels] = useState<ChannelModelDraft[]>([{ ...initialModelDraft }]);

  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [modelEditingId, setModelEditingId] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(initialModelForm);
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

    const response = await authedFetch("/api/dashboard/channels");
    const data = await response.json();

    if (!response.ok) {
      setError(data?.error?.message ?? "加载失败");
      return;
    }

    setChannels(data.data ?? []);
  }

  useEffect(() => {
    void load();
  }, [router]);

  function toggleChannelExpand(id: number) {
    setExpandedChannelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function openCreateChannel() {
    setChannelEditingId(null);
    setChannelForm(initialChannelForm);
    setChannelModels([{ ...initialModelDraft }]);
    setChannelDrawerOpen(true);
  }

  function openEditChannel(row: Channel) {
    setChannelEditingId(row.id);
    setChannelForm({
      name: row.name,
      base_url: row.base_url,
      api_key: row.api_key,
      weight: row.weight,
      timeout: row.timeout,
    });
    setChannelModels([{ ...initialModelDraft }]);
    setChannelDrawerOpen(true);
  }

  function addChannelModelDraft() {
    setChannelModels((prev) => [...prev, { ...initialModelDraft }]);
  }

  function removeChannelModelDraft(index: number) {
    setChannelModels((prev) => prev.filter((_, i) => i !== index));
  }

  function updateChannelModelDraft(index: number, patch: Partial<ChannelModelDraft>) {
    setChannelModels((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function submitChannel(event: FormEvent) {
    event.preventDefault();

    if (channelEditingId === null) {
      const draftModels = channelModels
        .map((item) => ({
          alias: item.alias.trim(),
          real_model: item.real_model.trim(),
          weight: item.weight,
          enabled: item.enabled,
        }))
        .filter((item) => item.alias && item.real_model);

      const response = await authedFetch("/api/dashboard/channels", {
        method: "POST",
        body: JSON.stringify({
          name: channelForm.name,
          base_url: channelForm.base_url,
          api_key: channelForm.api_key,
          weight: channelForm.weight,
          timeout: channelForm.timeout,
          models: draftModels,
        }),
      });
      const data = await response.json().catch(() => null);

      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "创建渠道成功。") });
        setChannelDrawerOpen(false);
        await load();
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "创建渠道失败。") });
      return;
    }

    const response = await authedFetch(`/api/dashboard/channels/${channelEditingId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: channelForm.name,
        base_url: channelForm.base_url,
        api_key: channelForm.api_key,
        weight: channelForm.weight,
        timeout: channelForm.timeout,
      }),
    });
    const data = await response.json().catch(() => null);

    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新渠道成功。") });
      setChannelDrawerOpen(false);
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新渠道失败。") });
  }

  async function toggleChannel(row: Channel) {
    const response = await authedFetch(`/api/dashboard/channels/${row.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: row.enabled !== 1 }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新渠道状态成功。") });
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新渠道状态失败。") });
  }

  async function removeChannel(id: number) {
    const response = await authedFetch(`/api/dashboard/channels/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除渠道成功。") });
      setExpandedChannelIds((prev) => prev.filter((x) => x !== id));
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除渠道失败。") });
  }

  async function testModel(row: ModelRow) {
    setTestingModelId(row.id);
    try {
      const response = await authedFetch(`/api/dashboard/models/${row.id}/test`, {
        method: "POST",
      });
      const data = await response.json().catch(() => null);
      const payload = data?.data as
        | {
            status: number | null;
            latency_ms: number;
            body_preview: string;
          }
        | undefined;

      const suffix = payload
        ? `HTTP ${payload.status ?? "-"}，${payload.latency_ms}ms${payload.body_preview ? `，${payload.body_preview}` : ""}`
        : "";

      if (response.ok) {
        toast({
          variant: "success",
          description: suffix ? `模型测试成功。${suffix}` : getApiMessage(data, "模型测试成功。"),
        });
        return;
      }

      toast({
        variant: "error",
        description: suffix ? `模型测试失败。${suffix}` : getApiMessage(data, "模型测试失败。"),
      });
    } finally {
      setTestingModelId(null);
    }
  }

  function openCreateModel(channelId: number) {
    setModelEditingId(null);
    setModelForm({
      ...initialModelForm,
      channel_id: channelId,
    });
    setModelDrawerOpen(true);
  }

  function openEditModel(row: ModelRow) {
    setModelEditingId(row.id);
    setModelForm({
      alias: row.alias,
      real_model: row.real_model,
      channel_id: row.channel_id,
      weight: row.weight,
      enabled: row.enabled === 1,
    });
    setModelDrawerOpen(true);
  }

  async function submitModel(event: FormEvent) {
    event.preventDefault();

    if (modelEditingId === null) {
      const response = await authedFetch("/api/dashboard/models", {
        method: "POST",
        body: JSON.stringify(modelForm),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "创建模型成功。") });
        setModelDrawerOpen(false);
        await load();
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "创建模型失败。") });
      return;
    }

    const response = await authedFetch(`/api/dashboard/models/${modelEditingId}`, {
      method: "PUT",
      body: JSON.stringify(modelForm),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新模型成功。") });
      setModelDrawerOpen(false);
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新模型失败。") });
  }

  async function toggleModel(row: ModelRow) {
    const response = await authedFetch(`/api/dashboard/models/${row.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: row.enabled !== 1 }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新模型状态成功。") });
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新模型状态失败。") });
  }

  async function removeModel(id: number) {
    const response = await authedFetch(`/api/dashboard/models/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除模型成功。") });
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除模型失败。") });
  }

  return (
    <DashboardShell
      role="admin"
      title="渠道管理"
      subtitle="一个页面管理多个渠道；展开渠道后管理该渠道的多个模型"
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>渠道列表</CardTitle>
                <CardDescription>共 {channels.length} 条</CardDescription>
              </div>
              <Button onClick={openCreateChannel}>新增渠道</Button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col px-0 pb-2 pt-0">
            {error ? <p className="px-6 pb-2 text-sm text-red-400">{error}</p> : null}
            <div className="min-h-0 flex-1 overflow-x-auto px-6">
              <div className="h-full w-full overflow-auto rounded-md border border-zinc-800">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead>Base URL</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>权重</TableHead>
                      <TableHead>超时</TableHead>
                      <TableHead>模型数</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {channels.map((row) => {
                      const expanded = expandedChannelIds.includes(row.id);
                      const channelModelsList = row.models ?? [];

                      return (
                        <Fragment key={row.id}>
                          <TableRow>
                            <TableCell>{row.id}</TableCell>
                            <TableCell>{row.name}</TableCell>
                            <TableCell className="max-w-72 truncate">{row.base_url}</TableCell>
                            <TableCell>
                              <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
                            </TableCell>
                            <TableCell>{row.weight}</TableCell>
                            <TableCell>{row.timeout}s</TableCell>
                            <TableCell>{channelModelsList.length}</TableCell>
                            <TableCell className="space-x-2 text-right">
                              <Button size="sm" variant="outline" onClick={() => toggleChannelExpand(row.id)}>
                                {expanded ? "收起模型" : "展开模型"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => openEditChannel(row)}>编辑</Button>
                              <Button size="sm" variant="outline" onClick={() => toggleChannel(row)}>
                                {row.enabled ? "禁用" : "启用"}
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => removeChannel(row.id)}>删除</Button>
                            </TableCell>
                          </TableRow>
                          {expanded ? (
                            <TableRow key={`${row.id}-models`}>
                              <TableCell colSpan={8} className="bg-zinc-950/40">
                                <div className="space-y-3 py-2">
                                  <div className="flex items-center justify-between">
                                    <p className="text-sm text-zinc-300">渠道模型（{channelModelsList.length}）</p>
                                    <Button size="sm" onClick={() => openCreateModel(row.id)}>新增模型</Button>
                                  </div>

                                  <div className="rounded-lg border border-zinc-800">
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead>ID</TableHead>
                                          <TableHead>别名</TableHead>
                                          <TableHead>真实模型</TableHead>
                                          <TableHead>状态</TableHead>
                                          <TableHead>权重</TableHead>
                                          <TableHead className="text-right">操作</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {channelModelsList.map((model) => (
                                          <TableRow key={model.id}>
                                            <TableCell>{model.id}</TableCell>
                                            <TableCell>{model.alias}</TableCell>
                                            <TableCell>{model.real_model}</TableCell>
                                            <TableCell>
                                              <Badge variant={model.enabled ? "default" : "secondary"}>{model.enabled ? "启用" : "禁用"}</Badge>
                                            </TableCell>
                                            <TableCell>{model.weight}</TableCell>
                                            <TableCell className="space-x-2 text-right">
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => testModel(model)}
                                                disabled={testingModelId === model.id}
                                              >
                                                {testingModelId === model.id ? "测试中..." : "测试"}
                                              </Button>
                                              <Button size="sm" variant="outline" onClick={() => openEditModel(model)}>编辑</Button>
                                              <Button size="sm" variant="outline" onClick={() => toggleModel(model)}>{model.enabled ? "禁用" : "启用"}</Button>
                                              <Button size="sm" variant="secondary" onClick={() => removeModel(model.id)}>删除</Button>
                                            </TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <SideDrawer
        open={channelDrawerOpen}
        onClose={() => setChannelDrawerOpen(false)}
        title={channelEditingId === null ? "新增渠道" : `编辑渠道 #${channelEditingId}`}
        description={channelEditingId === null ? "可一次添加多个模型" : "编辑渠道信息"}
      >
        <form onSubmit={submitChannel} className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>渠道名称</Label>
            <Input value={channelForm.name} onChange={(e) => setChannelForm({ ...channelForm, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>权重</Label>
            <Input type="number" min={1} value={channelForm.weight} onChange={(e) => setChannelForm({ ...channelForm, weight: Number(e.target.value) || 1 })} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Base URL</Label>
            <Input value={channelForm.base_url} onChange={(e) => setChannelForm({ ...channelForm, base_url: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>超时(秒)</Label>
            <Input type="number" min={1} value={channelForm.timeout} onChange={(e) => setChannelForm({ ...channelForm, timeout: Number(e.target.value) || 60 })} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>API Key</Label>
            <Input value={channelForm.api_key} onChange={(e) => setChannelForm({ ...channelForm, api_key: e.target.value })} />
          </div>

          {channelEditingId === null ? (
            <div className="md:col-span-2 space-y-3 rounded-lg border border-zinc-800 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">初始模型列表（可选）</p>
                <Button type="button" variant="outline" size="sm" onClick={addChannelModelDraft}>添加模型</Button>
              </div>
              {channelModels.map((item, index) => (
                <div key={index} className="grid gap-2 md:grid-cols-4 rounded-md border border-zinc-800 p-2">
                  <Input placeholder="别名" value={item.alias} onChange={(e) => updateChannelModelDraft(index, { alias: e.target.value })} />
                  <Input placeholder="真实模型" value={item.real_model} onChange={(e) => updateChannelModelDraft(index, { real_model: e.target.value })} />
                  <Input type="number" min={1} placeholder="权重" value={item.weight} onChange={(e) => updateChannelModelDraft(index, { weight: Number(e.target.value) || 1 })} />
                  <div className="flex items-center gap-2">
                    <select
                      className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                      value={item.enabled ? "1" : "0"}
                      onChange={(e) => updateChannelModelDraft(index, { enabled: e.target.value === "1" })}
                    >
                      <option value="1">启用</option>
                      <option value="0">禁用</option>
                    </select>
                    <Button type="button" variant="secondary" size="sm" onClick={() => removeChannelModelDraft(index)}>Delete</Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="md:col-span-2 flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setChannelDrawerOpen(false)}>取消</Button>
            <Button type="submit">{channelEditingId === null ? "创建" : "保存"}</Button>
          </div>
        </form>
      </SideDrawer>

      <SideDrawer
        open={modelDrawerOpen}
        onClose={() => setModelDrawerOpen(false)}
        title={modelEditingId === null ? "新增模型" : `编辑模型 #${modelEditingId}`}
        description="当前模型只归属于一个渠道"
      >
        <form onSubmit={submitModel} className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>别名</Label>
            <Input value={modelForm.alias} onChange={(e) => setModelForm({ ...modelForm, alias: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>真实模型</Label>
            <Input value={modelForm.real_model} onChange={(e) => setModelForm({ ...modelForm, real_model: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>所属渠道</Label>
            <select
              className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
              value={modelForm.channel_id}
              onChange={(e) => setModelForm({ ...modelForm, channel_id: Number(e.target.value) })}
            >
              {channels.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>权重</Label>
            <Input type="number" min={1} value={modelForm.weight} onChange={(e) => setModelForm({ ...modelForm, weight: Number(e.target.value) || 1 })} />
          </div>
          <div className="space-y-2">
            <Label>状态</Label>
            <select
              className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
              value={modelForm.enabled ? "1" : "0"}
              onChange={(e) => setModelForm({ ...modelForm, enabled: e.target.value === "1" })}
            >
              <option value="1">启用</option>
              <option value="0">禁用</option>
            </select>
          </div>

          <div className="md:col-span-2 flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModelDrawerOpen(false)}>取消</Button>
            <Button type="submit">{modelEditingId === null ? "创建" : "保存"}</Button>
          </div>
        </form>
      </SideDrawer>
    </DashboardShell>
  );
}
