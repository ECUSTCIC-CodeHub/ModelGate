"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { authedFetch, ensureAdmin } from "@/lib/auth/client-auth";
import { getApiMessage } from "@/lib/shared/api-message";
import {
  initialChannelForm,
  initialModelDraft,
  initialModelForm,
  parseSupportedProtocols,
  type Channel,
  type ChannelForm,
  type ChannelModelDraft,
  type ModelForm,
  type ModelRow,
  type ModelWithChannel,
  type Protocol,
  type UpstreamModelOption,
} from "./channel-model";

export function useChannelAdmin() {
  const router = useRouter();
  const { toast } = useToast();
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
  const [upstreamPickerOpen, setUpstreamPickerOpen] = useState(false);
  const [upstreamPickerQuery, setUpstreamPickerQuery] = useState("");
  const [upstreamModelOptions, setUpstreamModelOptions] = useState<UpstreamModelOption[]>([]);

  async function load() {
    if (!(await ensureAdmin(router))) return;

    const response = await authedFetch("/api/admin/channels");
    const data = await response.json();

    if (!response.ok) {
      setError(data?.error?.message ?? "加载失败");
      return;
    }

    setError("");
    setChannels(data.data ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!(await ensureAdmin(router))) return;
      if (cancelled) return;
      const response = await authedFetch("/api/admin/channels");
      if (cancelled) return;
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? "加载失败");
        return;
      }
      setChannels(data.data ?? []);
    }
    void init();
    return () => { cancelled = true; };
  }, [router]);

  function openCreateChannel() {
    setChannelEditingId(null);
    setChannelForm({ ...initialChannelForm });
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

  function updateChannelForm(patch: Partial<ChannelForm>) {
    setChannelForm((prev) => ({ ...prev, ...patch }));
  }

  function updateSupportedProtocols(protocols: Protocol[]) {
    const nextProtocols: Protocol[] = protocols.length > 0 ? protocols : ["chat_completions"];
    setChannelForm((prev) => ({ ...prev, supported_protocols: nextProtocols }));
    setChannelModels((prev) => prev.map((item) => ({
      ...item,
      upstream_protocol: nextProtocols.includes(item.upstream_protocol) ? item.upstream_protocol : nextProtocols[0],
    })));
  }

  function addChannelModelDraft(protocols = channelForm.supported_protocols) {
    setChannelModels((prev) => [...prev, { ...initialModelDraft, upstream_protocol: protocols[0] ?? "chat_completions" }]);
  }

  function removeChannelModelDraft(index: number) {
    setChannelModels((prev) => prev.filter((_, i) => i !== index));
  }

  function updateChannelModelDraft(index: number, patch: Partial<ChannelModelDraft>) {
    setChannelModels((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function probeUpstreamModels(baseUrl: string, apiKey: string, existingModels: ModelRow[] = []) {
    if (!baseUrl.trim() || !apiKey.trim()) {
      toast({ variant: "error", description: "请先填写 Base URL 与 API Key。" });
      return;
    }
    setProbingModels(true);
    try {
      const response = await authedFetch("/api/admin/channels/probe-models", {
        method: "POST",
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          api_key: apiKey.trim(),
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
      const existingRealModels = new Set(existingModels.map((model) => model.real_model.trim()).filter(Boolean));
      const seen = new Set<string>();
      const options = ids
        .map((id) => id.trim())
        .filter((id) => {
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .map<UpstreamModelOption>((id) => ({
          id,
          selected: existingRealModels.has(id),
          disabled: existingRealModels.has(id),
        }));
      setUpstreamModelOptions(options);
      setUpstreamPickerQuery("");
      setUpstreamPickerOpen(true);
      toast({ variant: "success", description: `已拉取 ${options.length} 个模型，请选择要加入草稿的模型。` });
    } finally {
      setProbingModels(false);
    }
  }

  function toggleUpstreamModel(id: string, selected: boolean) {
    setUpstreamModelOptions((prev) =>
      prev.map((item) => (item.id === id && !item.disabled ? { ...item, selected } : item)),
    );
  }

  function selectFilteredUpstreamModels(selected: boolean) {
    const query = upstreamPickerQuery.trim().toLowerCase();
    setUpstreamModelOptions((prev) =>
      prev.map((item) => {
        const visible = !query || item.id.toLowerCase().includes(query);
        return visible && !item.disabled ? { ...item, selected } : item;
      }),
    );
  }

  function confirmUpstreamModelSelection(protocols = channelForm.supported_protocols) {
    const selectedIds = upstreamModelOptions.filter((item) => item.selected && !item.disabled).map((item) => item.id);
    if (selectedIds.length === 0) {
      toast({ variant: "error", description: "请选择至少一个要加入草稿的上游模型。" });
      return;
    }

    const protocol = protocols[0] ?? "chat_completions";
    const currentDraftRealModels = new Set(channelModels.map((model) => model.real_model.trim()).filter(Boolean));
    const selectedNewIds = selectedIds.filter((id) => !currentDraftRealModels.has(id));
    if (selectedNewIds.length === 0) {
      toast({ variant: "error", description: "所选模型已在当前草稿中。" });
      return;
    }
    setChannelModels((prev) => {
      const filledFromPrev = prev.filter((model) => model.alias.trim() || model.real_model.trim());
      const existingRealModels = new Set(filledFromPrev.map((model) => model.real_model.trim()).filter(Boolean));
      const additions = selectedNewIds
        .filter((id) => !existingRealModels.has(id))
        .map<ChannelModelDraft>((id) => ({
          ...initialModelDraft,
          alias: id,
          real_model: id,
          upstream_protocol: protocol,
        }));
      const merged = [...filledFromPrev, ...additions];
      return merged.length > 0 ? merged : [{ ...initialModelDraft, upstream_protocol: protocol }];
    });
    setUpstreamPickerOpen(false);
    toast({ variant: "success", description: `已加入 ${selectedNewIds.length} 个模型草稿。` });
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

      const response = await authedFetch("/api/admin/channels", {
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

    const response = await authedFetch(`/api/admin/channels/${channelEditingId}`, {
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
    const response = await authedFetch(`/api/admin/channels/${row.id}`, {
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
    const response = await authedFetch(`/api/admin/channels/${id}`, { method: "DELETE" });
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
      const response = await authedFetch(`/api/admin/models/${row.id}/test`, {
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
    setChannelModels([{ ...initialModelDraft, upstream_protocol: supportedProtocols[0] ?? "chat_completions" }]);
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
      token_multiplier: row.token_multiplier ?? 1,
      request_multiplier: row.request_multiplier ?? 1,
      enabled: row.enabled === 1,
    });
    setModelDrawerOpen(true);
  }

  function updateModelForm(patch: Partial<ModelForm>) {
    setModelForm((prev) => ({ ...prev, ...patch }));
  }

  function updateModelChannel(channelId: number) {
    const channel = channels.find((item) => item.id === channelId);
    const protocols = parseSupportedProtocols(channel?.supported_protocols);
    setModelForm((prev) => ({
      ...prev,
      channel_id: channelId,
      upstream_protocol: protocols.includes(prev.upstream_protocol) ? prev.upstream_protocol : protocols[0],
    }));
    if (modelEditingId === null) {
      setChannelModels([{ ...initialModelDraft, upstream_protocol: protocols[0] ?? "chat_completions" }]);
    }
  }

  async function submitModel(event: FormEvent) {
    event.preventDefault();

    if (modelEditingId === null) {
      const draftModels = channelModels
        .map((item) => ({
          alias: item.alias.trim(),
          real_model: item.real_model.trim(),
          channel_id: modelForm.channel_id,
          upstream_protocol: item.upstream_protocol,
          is_public: item.is_public,
          weight: item.weight,
          token_multiplier: item.token_multiplier,
          request_multiplier: item.request_multiplier,
          enabled: item.enabled,
        }))
        .filter((item) => item.alias && item.real_model);

      if (draftModels.length === 0) {
        toast({ variant: "error", description: "请至少填写一个模型草稿。" });
        return;
      }

      const batchSize = 5;
      const results: PromiseSettledResult<{ ok: boolean; draft: typeof draftModels[number]; data: unknown }>[] = [];
      for (let i = 0; i < draftModels.length; i += batchSize) {
        const batch = draftModels.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map((draft) =>
            authedFetch("/api/admin/models", {
              method: "POST",
              body: JSON.stringify(draft),
            }).then(async (response) => {
              const data = await response.json().catch(() => null);
              return { ok: response.ok, draft, data };
            }),
          ),
        );
        results.push(...batchResults);
      }

      let successCount = 0;
      const failures: string[] = [];
      const failedDrafts: ChannelModelDraft[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          const { ok, draft, data } = result.value;
          if (ok) {
            successCount += 1;
          } else {
            failures.push(`${draft.real_model}（${getApiMessage(data, "创建失败")}）`);
            failedDrafts.push({
              alias: draft.alias,
              real_model: draft.real_model,
              upstream_protocol: draft.upstream_protocol,
              is_public: draft.is_public,
              weight: draft.weight,
              token_multiplier: draft.token_multiplier,
              request_multiplier: draft.request_multiplier,
              enabled: draft.enabled,
            });
          }
        } else {
          const draft = draftModels[i];
          failures.push(`${draft.real_model}（请求异常）`);
          failedDrafts.push({
            alias: draft.alias,
            real_model: draft.real_model,
            upstream_protocol: draft.upstream_protocol,
            is_public: draft.is_public,
            weight: draft.weight,
            token_multiplier: draft.token_multiplier,
            request_multiplier: draft.request_multiplier,
            enabled: draft.enabled,
          });
        }
      }

      if (failures.length === 0) {
        toast({ variant: "success", description: `已创建 ${successCount} 个模型。` });
        setModelDrawerOpen(false);
        await load();
        return;
      }
      toast({
        variant: successCount > 0 ? "info" : "error",
        description: `已创建 ${successCount} 个模型，${failures.length} 个失败：${failures.slice(0, 3).join("；")}${failures.length > 3 ? " 等" : ""}。`,
        durationMs: 6000,
      });
      setChannelModels(failedDrafts.length > 0 ? failedDrafts : [{ ...initialModelDraft, upstream_protocol: selectedChannelProtocols[0] ?? "chat_completions" }]);
      if (successCount > 0) await load();
      return;
    }

    const response = await authedFetch(`/api/admin/models/${modelEditingId}`, {
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
    const response = await authedFetch(`/api/admin/models/${row.id}`, {
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
    const response = await authedFetch(`/api/admin/models/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除模型成功。") });
      await load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除模型失败。") });
  }

  const allModels: ModelWithChannel[] = channels.flatMap((channel) =>
    (channel.models ?? []).map((model) => ({
      ...model,
      channel_name: channel.name,
    })),
  );
  const selectedChannel = channels.find((item) => item.id === modelForm.channel_id);
  const selectedChannelProtocols = parseSupportedProtocols(selectedChannel?.supported_protocols);
  const activeDraftProtocols = modelDrawerOpen && modelEditingId === null ? selectedChannelProtocols : channelForm.supported_protocols;

  return {
    activeDraftProtocols,
    addChannelModelDraft,
    allModels,
    channelDrawerOpen,
    channelEditingId,
    channelForm,
    channelModels,
    channels,
    confirmUpstreamModelSelection,
    error,
    modelDrawerOpen,
    modelEditingId,
    modelForm,
    openCreateChannel,
    openCreateModel,
    openEditChannel,
    openEditModel,
    probingModels,
    probeUpstreamModels,
    removeChannel,
    removeChannelModelDraft,
    removeModel,
    selectedChannel,
    selectedChannelProtocols,
    selectFilteredUpstreamModels,
    setChannelDrawerOpen,
    setModelDrawerOpen,
    setUpstreamPickerOpen,
    setUpstreamPickerQuery,
    submitChannel,
    submitModel,
    testingModelId,
    testModel,
    toggleChannel,
    toggleModel,
    toggleUpstreamModel,
    updateChannelForm,
    updateChannelModelDraft,
    updateModelChannel,
    updateModelForm,
    updateSupportedProtocols,
    upstreamModelOptions,
    upstreamPickerOpen,
    upstreamPickerQuery,
  };
}
