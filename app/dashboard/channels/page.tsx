/* eslint-disable react-hooks/exhaustive-deps */
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession, getOrFetchProfile } from "@/lib/client-auth";

type Protocol = "chat_completions" | "responses" | "anthropic_messages";

const protocolOptions: Array<{ value: Protocol; label: string }> = [
  { value: "chat_completions", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
  { value: "anthropic_messages", label: "Claude Messages" },
];

function parseSupportedProtocols(raw: string | null | undefined): Protocol[] {
  if (!raw) return ["chat_completions"];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = Array.isArray(parsed)
      ? parsed.filter((item): item is Protocol => item === "chat_completions" || item === "responses" || item === "anthropic_messages")
      : [];
    return normalized.length > 0 ? normalized : ["chat_completions"];
  } catch {
    return ["chat_completions"];
  }
}

type ModelRow = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  is_public: number;
  enabled: number;
  weight: number;
};

type Channel = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: string;
  enabled: number;
  weight: number;
  max_concurrency: number;
  timeout: number;
  models?: ModelRow[];
};

type ChannelModelDraft = {
  alias: string;
  real_model: string;
  upstream_protocol: Protocol;
  is_public: boolean;
  weight: number;
  enabled: boolean;
};

type ChannelForm = {
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: Protocol[];
  weight: number;
  max_concurrency: number;
  timeout: number;
};

type ModelForm = {
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  is_public: boolean;
  weight: number;
  enabled: boolean;
};

const initialChannelForm: ChannelForm = {
  name: "",
  base_url: "",
  api_key: "",
  supported_protocols: ["chat_completions"],
  weight: 1,
  max_concurrency: 64,
  timeout: 60,
};

const initialModelDraft: ChannelModelDraft = {
  alias: "",
  real_model: "",
  upstream_protocol: "chat_completions",
  is_public: true,
  weight: 1,
  enabled: true,
};

const initialModelForm: ModelForm = {
  alias: "",
  real_model: "",
  channel_id: 0,
  upstream_protocol: "chat_completions",
  is_public: true,
  weight: 1,
  enabled: true,
};

export default function AdminChannelsPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState("");
  const [testingModelId, setTestingModelId] = useState<number | null>(null);

  const [channelDrawerOpen, setChannelDrawerOpen] = useState(false);
  const [channelEditingId, setChannelEditingId] = useState<number | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelForm>(initialChannelForm);
  const [channelModels, setChannelModels] = useState<ChannelModelDraft[]>([{ ...initialModelDraft }]);
  const [probingModels, setProbingModels] = useState(false);

  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [modelEditingId, setModelEditingId] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(initialModelForm);
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

  function openCreateChannel() {
    setChannelEditingId(null);
    setChannelForm(initialChannelForm);
    setChannelModels([{ ...initialModelDraft, upstream_protocol: initialChannelForm.supported_protocols[0] }]);
    setChannelDrawerOpen(true);
  }

  function openEditChannel(row: Channel) {
    const supportedProtocols = parseSupportedProtocols(row.supported_protocols);
    setChannelEditingId(row.id);
    setChannelForm({
      name: row.name,
      base_url: row.base_url,
      api_key: row.api_key,
      supported_protocols: supportedProtocols,
      weight: row.weight,
      max_concurrency: row.max_concurrency,
      timeout: row.timeout,
    });
    setChannelModels([{ ...initialModelDraft, upstream_protocol: supportedProtocols[0] }]);
    setChannelDrawerOpen(true);
  }

  function addChannelModelDraft() {
    setChannelModels((prev) => [...prev, { ...initialModelDraft, upstream_protocol: channelForm.supported_protocols[0] ?? "chat_completions" }]);
  }

  function removeChannelModelDraft(index: number) {
    setChannelModels((prev) => prev.filter((_, i) => i !== index));
  }

  function updateChannelModelDraft(index: number, patch: Partial<ChannelModelDraft>) {
    setChannelModels((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function probeUpstreamModels() {
    if (!channelForm.base_url.trim() || !channelForm.api_key.trim()) {
      toast({ variant: "error", description: "请先填写 Base URL 与 API Key。" });
      return;
    }
    setProbingModels(true);
    try {
      const response = await authedFetch("/api/dashboard/channels/probe-models", {
        method: "POST",
        body: JSON.stringify({
          base_url: channelForm.base_url.trim(),
          api_key: channelForm.api_key.trim(),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "拉取上游模型列表失败。") });
        return;
      }
      const ids = (data?.data ?? []) as string[];
      if (ids.length === 0) {
        toast({ variant: "error", description: "上游未返回任何模型。" });
        return;
      }
      const protocol = channelForm.supported_protocols[0] ?? "chat_completions";
      setChannelModels((prev) => {
        const existingAliases = new Set(prev.map((m) => m.alias.trim()).filter(Boolean));
        const filledFromPrev = prev.filter((m) => m.alias.trim() || m.real_model.trim());
        const additions = ids
          .filter((id) => !existingAliases.has(id))
          .map<ChannelModelDraft>((id) => ({
            ...initialModelDraft,
            alias: id,
            real_model: id,
            upstream_protocol: protocol,
          }));
        const merged = [...filledFromPrev, ...additions];
        return merged.length > 0 ? merged : [{ ...initialModelDraft, upstream_protocol: protocol }];
      });
      toast({ variant: "success", description: `已拉取 ${ids.length} 个模型，可继续编辑别名。` });
    } finally {
      setProbingModels(false);
    }
  }

  async function submitChannel(event: FormEvent) {
    event.preventDefault();

    if (channelEditingId === null) {
      const draftModels = channelModels
        .map((item) => ({
          alias: item.alias.trim(),
          real_model: item.real_model.trim(),
          upstream_protocol: item.upstream_protocol,
          is_public: item.is_public,
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
          supported_protocols: channelForm.supported_protocols,
          weight: channelForm.weight,
          max_concurrency: channelForm.max_concurrency,
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
        supported_protocols: channelForm.supported_protocols,
        weight: channelForm.weight,
        max_concurrency: channelForm.max_concurrency,
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
            summary?: string | null;
            body_preview: string;
          }
        | undefined;

      const suffix = payload
        ? `HTTP ${payload.status ?? "-"}，${payload.latency_ms}ms${
            payload.summary
              ? `，${payload.summary}`
              : payload.body_preview
                ? `，${payload.body_preview}`
                : ""
          }`
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
    const channel = channels.find((item) => item.id === channelId);
    const supportedProtocols = parseSupportedProtocols(channel?.supported_protocols);
    setModelEditingId(null);
    setModelForm({
      ...initialModelForm,
      channel_id: channelId,
      upstream_protocol: supportedProtocols[0] ?? "chat_completions",
    });
    setModelDrawerOpen(true);
  }

  function openEditModel(row: ModelRow) {
    setModelEditingId(row.id);
    setModelForm({
      alias: row.alias,
      real_model: row.real_model,
      channel_id: row.channel_id,
      upstream_protocol: row.upstream_protocol,
      is_public: row.is_public === 1,
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

  const allModels = channels.flatMap((channel) =>
    (channel.models ?? []).map((model) => ({
      ...model,
      channel_name: channel.name,
    })),
  );
  const selectedChannelProtocols = parseSupportedProtocols(channels.find((item) => item.id === modelForm.channel_id)?.supported_protocols);

  return (
    <DashboardShell
      role="admin"
      title="渠道与模型管理"
      subtitle="统一管理上游渠道、模型映射、状态、权重与测试动作。"
    >
      <div className="space-y-4 pb-6">
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <Card>
          <CardHeader>
            <SectionTitle title="渠道与模型配置" description="在渠道标签页管理上游 API 接入，在模型标签页配置 alias 与真实模型映射。" />
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="channels" className="space-y-4">
              <TabsList>
                <TabsTrigger value="channels">渠道</TabsTrigger>
                <TabsTrigger value="models">模型映射</TabsTrigger>
              </TabsList>

              <TabsContent value="channels" className="space-y-4">
                <PageToolbar>
                  <p className="text-sm text-zinc-400">渠道代表一条上游 API 接入，包含 Base URL、API Key、超时和权重。</p>
                  <Button onClick={openCreateChannel}>新增渠道</Button>
                </PageToolbar>
                {channels.length > 0 ? (
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <Table className="min-w-[960px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>序号</TableHead>
                          <TableHead>名称</TableHead>
                          <TableHead>Base URL</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>协议</TableHead>
                          <TableHead>权重</TableHead>
                          <TableHead>最大并发</TableHead>
                          <TableHead>超时</TableHead>
                          <TableHead>模型数</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {channels.map((row, channelIndex) => (
                          <TableRow key={row.id}>
                            <TableCell>{channelIndex + 1}</TableCell>
                            <TableCell>{row.name}</TableCell>
                            <TableCell className="max-w-72 truncate">{row.base_url}</TableCell>
                            <TableCell>
                              <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {parseSupportedProtocols(row.supported_protocols).map((protocol: Protocol) => (
                                  <Badge key={protocol} variant="outline">{protocol === "responses" ? "Responses" : protocol === "anthropic_messages" ? "Claude" : "Chat"}</Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell>{row.weight}</TableCell>
                            <TableCell>{row.max_concurrency}</TableCell>
                            <TableCell>{row.timeout}s</TableCell>
                            <TableCell>{row.models?.length ?? 0}</TableCell>
                            <TableCell className="space-x-2 text-right">
                              <Button size="sm" variant="outline" onClick={() => openEditChannel(row)}>编辑</Button>
                              <Button size="sm" variant="outline" onClick={() => toggleChannel(row)}>
                                {row.enabled ? "禁用" : "启用"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => openCreateModel(row.id)}>新增模型</Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button size="sm" variant="destructive">删除</Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>删除渠道 {row.name}？</AlertDialogTitle>
                                    <AlertDialogDescription>删除渠道后，其下模型映射也将失效，此操作不可撤销。</AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>取消</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => removeChannel(row.id)}>确认删除</AlertDialogAction>
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
                  <EmptyState title="暂无接口渠道" description="先接入一个上游 API 渠道，再继续配置模型映射。" action={<Button onClick={openCreateChannel}>新增渠道</Button>} />
                )}
              </TabsContent>

              <TabsContent value="models" className="space-y-4">
                <PageToolbar>
                  <p className="text-sm text-zinc-400">模型映射决定外部调用时传入的 alias 如何路由到真实模型与渠道。</p>
                  <Button disabled={channels.length === 0} onClick={() => openCreateModel(channels[0]?.id ?? 0)}>新增模型映射</Button>
                </PageToolbar>
                {allModels.length > 0 ? (
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <Table className="min-w-[1020px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>序号</TableHead>
                          <TableHead>别名</TableHead>
                          <TableHead>真实模型</TableHead>
                          <TableHead>所属渠道</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>上游协议</TableHead>
                          <TableHead>可见性</TableHead>
                          <TableHead>权重</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {allModels.map((model, modelIndex) => (
                          <TableRow key={model.id}>
                            <TableCell>{modelIndex + 1}</TableCell>
                            <TableCell className="font-mono">{model.alias}</TableCell>
                            <TableCell>{model.real_model}</TableCell>
                            <TableCell>{model.channel_name}</TableCell>
                            <TableCell>
                              <Badge variant={model.enabled ? "default" : "secondary"}>{model.enabled ? "启用" : "禁用"}</Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{model.upstream_protocol === "responses" ? "Responses" : model.upstream_protocol === "anthropic_messages" ? "Claude" : "Chat"}</Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant={model.is_public ? "default" : "secondary"}>{model.is_public ? "公开" : "白名单"}</Badge>
                            </TableCell>
                            <TableCell>{model.weight}</TableCell>
                            <TableCell className="space-x-2 text-right">
                              <Button size="sm" variant="outline" onClick={() => testModel(model)} disabled={testingModelId === model.id}>
                                {testingModelId === model.id ? "测试中..." : "测试"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => openEditModel(model)}>编辑</Button>
                              <Button size="sm" variant="outline" onClick={() => toggleModel(model)}>{model.enabled ? "禁用" : "启用"}</Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button size="sm" variant="destructive">删除</Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>删除模型映射 {model.alias}？</AlertDialogTitle>
                                    <AlertDialogDescription>删除后客户端将无法再通过该 alias 访问对应模型。</AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>取消</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => removeModel(model.id)}>确认删除</AlertDialogAction>
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
                  <EmptyState title="暂无模型映射" description="在渠道接入完成后，为客户端配置 alias 到真实模型的映射关系。" action={<Button disabled={channels.length === 0} onClick={() => openCreateModel(channels[0]?.id ?? 0)}>新增模型映射</Button>} />
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <Sheet open={channelDrawerOpen} onOpenChange={setChannelDrawerOpen}>
        <SheetContent side="right" className="sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{channelEditingId === null ? "新增接口渠道" : `编辑渠道 #${channelEditingId}`}</SheetTitle>
            <SheetDescription>配置渠道名称、Base URL、API Key、超时与默认模型草稿。</SheetDescription>
          </SheetHeader>
          <form onSubmit={submitChannel} className="mt-4 space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-4 md:grid-cols-2">
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
              <div className="space-y-2">
                <Label>最大并发</Label>
                <Input type="number" min={1} value={channelForm.max_concurrency} onChange={(e) => setChannelForm({ ...channelForm, max_concurrency: Number(e.target.value) || 1 })} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>支持协议</Label>
                <div className="grid gap-2 rounded-xl border border-white/10 bg-white/5 p-4 md:grid-cols-2">
                  {protocolOptions.map((option) => {
                    const checked = channelForm.supported_protocols.includes(option.value);
                    return (
                      <label key={option.value} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
                        <span className="text-sm text-zinc-100">{option.label}</span>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => {
                            const enabled = next === true;
                            const current = channelForm.supported_protocols;
                            const protocols = enabled
                              ? [...new Set([...current, option.value])]
                              : current.filter((item) => item !== option.value);
                            setChannelForm({
                              ...channelForm,
                              supported_protocols: protocols.length > 0 ? protocols : [option.value],
                            });
                            setChannelModels((prev) => prev.map((item) => ({
                              ...item,
                              upstream_protocol: (protocols.length > 0 ? protocols : [option.value]).includes(item.upstream_protocol)
                                ? item.upstream_protocol
                                : (protocols.length > 0 ? protocols : [option.value])[0],
                            })));
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>API Key</Label>
                <Input value={channelForm.api_key} onChange={(e) => setChannelForm({ ...channelForm, api_key: e.target.value })} />
              </div>
            </div>

            {channelEditingId === null ? (
              <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-zinc-100">初始模型列表</p>
                    <p className="text-xs text-zinc-500">别名就是客户端调用时传入的 model，支持 * 作为兜底模型。</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={probingModels}
                      onClick={() => void probeUpstreamModels()}
                    >
                      {probingModels ? "拉取中…" : "从上游拉取"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={addChannelModelDraft}>添加模型</Button>
                  </div>
                </div>
                <div className="space-y-3">
                  {channelModels.map((item, index) => (
                    <div key={index} className="grid gap-3 rounded-lg border border-white/10 p-3 md:grid-cols-2">
                      <Input placeholder="别名" value={item.alias} onChange={(e) => updateChannelModelDraft(index, { alias: e.target.value })} />
                      <Input placeholder="真实模型" value={item.real_model} onChange={(e) => updateChannelModelDraft(index, { real_model: e.target.value })} />
                      <Input type="number" min={1} placeholder="权重" value={item.weight} onChange={(e) => updateChannelModelDraft(index, { weight: Number(e.target.value) || 1 })} />
                      <Select value={item.upstream_protocol} onValueChange={(value: Protocol) => updateChannelModelDraft(index, { upstream_protocol: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {channelForm.supported_protocols.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>{protocol === "responses" ? "Responses" : protocol === "anthropic_messages" ? "Claude Messages" : "Chat Completions"}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="grid gap-3 md:grid-cols-2">
                        <Select value={item.is_public ? "1" : "0"} onValueChange={(value) => updateChannelModelDraft(index, { is_public: value === "1" })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">公开模型</SelectItem>
                            <SelectItem value="0">白名单模型</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select value={item.enabled ? "1" : "0"} onValueChange={(value) => updateChannelModelDraft(index, { enabled: value === "1" })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">启用</SelectItem>
                            <SelectItem value="0">禁用</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-2">
                        <Button type="button" variant="destructive" size="sm" onClick={() => removeChannelModelDraft(index)}>删除该草稿</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <SheetFooter>
              <Button type="button" variant="outline" onClick={() => setChannelDrawerOpen(false)}>取消</Button>
              <Button type="submit">{channelEditingId === null ? "创建" : "保存"}</Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet open={modelDrawerOpen} onOpenChange={setModelDrawerOpen}>
        <SheetContent side="right" className="sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{modelEditingId === null ? "新增模型映射" : `编辑模型 #${modelEditingId}`}</SheetTitle>
            <SheetDescription>配置 alias、真实模型、所属渠道、公开性与启用状态。</SheetDescription>
          </SheetHeader>
          <form onSubmit={submitModel} className="mt-4 space-y-4 overflow-y-auto pr-1">
            <p className="text-xs text-zinc-500">别名就是客户端请求时传入的 model，也支持 * 作为兜底模型。</p>
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
              <Select
                value={String(modelForm.channel_id)}
                onValueChange={(value) => {
                  const channelId = Number(value);
                  const channel = channels.find((item) => item.id === channelId);
                  const protocols = parseSupportedProtocols(channel?.supported_protocols);
                  setModelForm({
                    ...modelForm,
                    channel_id: channelId,
                    upstream_protocol: protocols.includes(modelForm.upstream_protocol) ? modelForm.upstream_protocol : protocols[0],
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>上游协议</Label>
              <Select value={modelForm.upstream_protocol} onValueChange={(value: Protocol) => setModelForm({ ...modelForm, upstream_protocol: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedChannelProtocols.map((protocol) => (
                    <SelectItem key={protocol} value={protocol}>{protocol === "responses" ? "Responses" : protocol === "anthropic_messages" ? "Claude Messages" : "Chat Completions"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>权重</Label>
              <Input type="number" min={1} value={modelForm.weight} onChange={(e) => setModelForm({ ...modelForm, weight: Number(e.target.value) || 1 })} />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-4">
              <div>
                <p className="text-sm font-medium text-zinc-100">公开模型</p>
                <p className="text-xs text-zinc-500">关闭后仅被授权用户可以访问该 alias。</p>
              </div>
              <Checkbox checked={modelForm.is_public} onCheckedChange={(checked) => setModelForm({ ...modelForm, is_public: checked === true })} />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-4">
              <div>
                <p className="text-sm font-medium text-zinc-100">启用状态</p>
                <p className="text-xs text-zinc-500">关闭后该模型映射不会被路由命中。</p>
              </div>
              <Checkbox checked={modelForm.enabled} onCheckedChange={(checked) => setModelForm({ ...modelForm, enabled: checked === true })} />
            </div>
            <SheetFooter>
              <Button type="button" variant="outline" onClick={() => setModelDrawerOpen(false)}>取消</Button>
              <Button type="submit">{modelEditingId === null ? "创建" : "保存"}</Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </DashboardShell>
  );
}
