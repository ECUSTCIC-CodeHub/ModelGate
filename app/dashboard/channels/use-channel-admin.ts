"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { authedFetch } from "@/lib/auth/client-auth";
import { modelGateFeatures } from "@/lib/core/features";
import { getApiMessage } from "@/lib/shared/api-message";
import {
  initialChannelForm,
  initialModelDraft,
  initialModelForm,
  parseSupportedProtocols,
  periodToPreset,
  type Channel,
  type ChannelForm,
  type ChannelModelDraft,
  type ModelForm,
  type ModelRow,
  type ModelWithChannel,
  type Protocol,
} from "./channel-model";
import { useChannelRecords } from "./use-channel-records";
import { useUpstreamModelPicker } from "./use-upstream-model-picker";

export function useChannelAdmin() {
  const { toast } = useToast();
  const { channels, error, loadChannels } = useChannelRecords();
  const [testingModelId, setTestingModelId] = useState<number | null>(null);

  const [channelDrawerOpen, setChannelDrawerOpen] = useState(false);
  const [channelEditingId, setChannelEditingId] = useState<number | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelForm>(initialChannelForm);
  const [channelModels, setChannelModels] = useState<ChannelModelDraft[]>([{ ...initialModelDraft }]);

  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [modelEditingId, setModelEditingId] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(initialModelForm);
  const upstreamPicker = useUpstreamModelPicker({
    channelModels,
    setChannelModels,
    getDefaultProtocols: () => channelForm.supported_protocols,
  });

  function openCreateChannel() {
    setChannelEditingId(null);
    setChannelForm({ ...initialChannelForm });
    setChannelModels([{ ...initialModelDraft, upstream_protocol: initialChannelForm.supported_protocols[0], supported_protocols: [...initialChannelForm.supported_protocols] }]);
    setChannelDrawerOpen(true);
  }

  function openEditChannel(row: Channel) {
    const supportedProtocols = parseSupportedProtocols(row.supported_protocols);
    setChannelEditingId(row.id);
    setChannelForm({
      name: row.name,
      base_url: row.base_url,
      api_key: row.api_key,
      user_agent: row.user_agent ?? "",
      supported_protocols: supportedProtocols,
      weight: row.weight,
      max_concurrency: row.max_concurrency,
      timeout: row.timeout,
      quota_tokens: row.quota_tokens != null ? String(row.quota_tokens) : "",
      quota_requests: row.quota_requests != null ? String(row.quota_requests) : "",
      quota_period_preset: periodToPreset(row.quota_period),
      quota_period_custom: row.quota_period != null && periodToPreset(row.quota_period) === "custom" ? String(row.quota_period) : "",
      period_quota_tokens: row.period_quota_tokens != null ? String(row.period_quota_tokens) : "",
      period_quota_requests: row.period_quota_requests != null ? String(row.period_quota_requests) : "",
      force_include_usage: row.force_include_usage === 1,
    });
    setChannelModels([{ ...initialModelDraft, upstream_protocol: supportedProtocols[0], supported_protocols: [...supportedProtocols] }]);
    setChannelDrawerOpen(true);
  }

  function updateChannelForm(patch: Partial<ChannelForm>) {
    setChannelForm((prev) => ({ ...prev, ...patch }));
  }

  function updateSupportedProtocols(protocols: Protocol[]) {
    const nextProtocols: Protocol[] = protocols.length > 0 ? protocols : ["chat_completions"];
    setChannelForm((prev) => ({ ...prev, supported_protocols: nextProtocols }));
    setChannelModels((prev) => prev.map((item) => {
      const filtered = item.supported_protocols.filter((p) => nextProtocols.includes(p));
      const nextSupported = filtered.length > 0 ? filtered : [nextProtocols[0]];
      return {
        ...item,
        supported_protocols: nextSupported,
        upstream_protocol: nextSupported.includes(item.upstream_protocol) ? item.upstream_protocol : nextSupported[0],
      };
    }));
  }

  function addChannelModelDraft(protocols = channelForm.supported_protocols) {
    setChannelModels((prev) => [...prev, { ...initialModelDraft, upstream_protocol: protocols[0] ?? "chat_completions", supported_protocols: [...protocols] }]);
  }

  function removeChannelModelDraft(index: number) {
    setChannelModels((prev) => prev.filter((_, i) => i !== index));
  }

  function updateChannelModelDraft(index: number, patch: Partial<ChannelModelDraft>) {
    setChannelModels((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function buildQuotaPayload(form: ChannelForm) {
    const periodSeconds = form.quota_period_preset === "custom"
      ? (form.quota_period_custom.trim() ? Number(form.quota_period_custom) : null)
      : form.quota_period_preset
        ? Number(form.quota_period_preset)
        : null;
    return {
      quota_tokens: form.quota_tokens.trim() ? Number(form.quota_tokens) : null,
      quota_requests: form.quota_requests.trim() ? Number(form.quota_requests) : null,
      quota_period: periodSeconds,
      period_quota_tokens: form.period_quota_tokens.trim() ? Number(form.period_quota_tokens) : null,
      period_quota_requests: form.period_quota_requests.trim() ? Number(form.period_quota_requests) : null,
    };
  }

  async function submitChannel(event: FormEvent) {
    event.preventDefault();

    if (channelEditingId === null) {
      const draftModels = channelModels
        .map((item) => ({
          alias: item.alias.trim(),
          real_model: item.real_model.trim(),
          upstream_protocol: item.upstream_protocol,
          supported_protocols: item.supported_protocols,
          is_public: item.is_public,
          enabled: item.enabled,
        }))
        .filter((item) => item.alias && item.real_model);

      const response = await authedFetch("/api/admin/channels", {
        method: "POST",
        body: JSON.stringify({
          name: channelForm.name,
          base_url: channelForm.base_url,
          api_key: channelForm.api_key,
          user_agent: channelForm.user_agent,
          supported_protocols: channelForm.supported_protocols,
          weight: channelForm.weight,
          max_concurrency: channelForm.max_concurrency,
          timeout: channelForm.timeout,
          force_include_usage: channelForm.force_include_usage,
          ...buildQuotaPayload(channelForm),
          models: draftModels,
        }),
      });
      const data = await response.json().catch(() => null);

      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "创建渠道成功。") });
        setChannelDrawerOpen(false);
        await loadChannels();
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
        user_agent: channelForm.user_agent,
        supported_protocols: channelForm.supported_protocols,
        weight: channelForm.weight,
        max_concurrency: channelForm.max_concurrency,
        timeout: channelForm.timeout,
        force_include_usage: channelForm.force_include_usage,
        ...buildQuotaPayload(channelForm),
      }),
    });
    const data = await response.json().catch(() => null);

    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新渠道成功。") });
      setChannelDrawerOpen(false);
      await loadChannels();
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
      await loadChannels();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新渠道状态失败。") });
  }

  async function removeChannel(id: number) {
    const response = await authedFetch(`/api/admin/channels/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除渠道成功。") });
      await loadChannels();
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
      supported_protocols: [...supportedProtocols],
    });
    setChannelModels([{ ...initialModelDraft, upstream_protocol: supportedProtocols[0] ?? "chat_completions", supported_protocols: [...supportedProtocols] }]);
    setModelDrawerOpen(true);
  }

  function openEditModel(row: ModelRow) {
    const modelProtocols = parseSupportedProtocols(row.supported_protocols);
    setModelEditingId(row.id);
    setModelForm({
      alias: row.alias,
      real_model: row.real_model,
      channel_id: row.channel_id,
      upstream_protocol: row.upstream_protocol,
      supported_protocols: modelProtocols,
      copilot_compatibility: row.copilot_compatibility === 1,
      is_public: row.is_public === 1,
      weight: row.weight,
      token_multiplier: row.token_multiplier ?? 1,
      request_multiplier: row.request_multiplier ?? 1,
      max_concurrency: row.max_concurrency ?? 0,
      quota_mode: row.quota_mode ?? "follow_group",
      quota_tokens: row.quota_tokens != null ? String(row.quota_tokens) : "",
      quota_requests: row.quota_requests != null ? String(row.quota_requests) : "",
      quota_period_preset: periodToPreset(row.quota_period),
      quota_period_custom: row.quota_period != null && periodToPreset(row.quota_period) === "custom" ? String(row.quota_period) : "",
      period_quota_tokens: row.period_quota_tokens != null ? String(row.period_quota_tokens) : "",
      period_quota_requests: row.period_quota_requests != null ? String(row.period_quota_requests) : "",
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
    setModelForm((prev) => {
      const filtered = prev.supported_protocols.filter((p) => protocols.includes(p));
      const nextSupported = filtered.length > 0 ? filtered : [protocols[0]];
      return {
        ...prev,
        channel_id: channelId,
        supported_protocols: nextSupported,
        upstream_protocol: nextSupported.includes(prev.upstream_protocol) ? prev.upstream_protocol : nextSupported[0],
      };
    });
    if (modelEditingId === null) {
      setChannelModels([{ ...initialModelDraft, upstream_protocol: protocols[0] ?? "chat_completions", supported_protocols: [...protocols] }]);
    }
  }

  function buildModelQuotaPayload(form: ModelForm) {
    const periodSeconds = form.quota_period_preset === "custom"
      ? (form.quota_period_custom.trim() ? Number(form.quota_period_custom) : null)
      : form.quota_period_preset
        ? Number(form.quota_period_preset)
        : null;
    return {
      quota_mode: form.quota_mode,
      quota_tokens: form.quota_tokens.trim() ? Number(form.quota_tokens) : null,
      quota_requests: form.quota_requests.trim() ? Number(form.quota_requests) : null,
      quota_period: periodSeconds,
      period_quota_tokens: form.period_quota_tokens.trim() ? Number(form.period_quota_tokens) : null,
      period_quota_requests: form.period_quota_requests.trim() ? Number(form.period_quota_requests) : null,
    };
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
          supported_protocols: item.supported_protocols,
          copilot_compatibility: item.copilot_compatibility,
          is_public: item.is_public,
          weight: item.weight,
          token_multiplier: item.token_multiplier,
          request_multiplier: item.request_multiplier,
          max_concurrency: item.max_concurrency,
          quota_mode: item.quota_mode,
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
              supported_protocols: draft.supported_protocols,
              copilot_compatibility: draft.copilot_compatibility,
              is_public: draft.is_public,
              weight: draft.weight,
              token_multiplier: draft.token_multiplier,
              request_multiplier: draft.request_multiplier,
              max_concurrency: draft.max_concurrency,
              quota_mode: draft.quota_mode ?? "follow_group",
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
            supported_protocols: draft.supported_protocols,
            copilot_compatibility: draft.copilot_compatibility,
            is_public: draft.is_public,
            weight: draft.weight,
            token_multiplier: draft.token_multiplier,
            request_multiplier: draft.request_multiplier,
            max_concurrency: draft.max_concurrency,
            quota_mode: draft.quota_mode ?? "follow_group",
            enabled: draft.enabled,
          });
        }
      }

      if (failures.length === 0) {
        toast({ variant: "success", description: `已创建 ${successCount} 个模型。` });
        setModelDrawerOpen(false);
        await loadChannels();
        return;
      }
      toast({
        variant: successCount > 0 ? "info" : "error",
        description: `已创建 ${successCount} 个模型，${failures.length} 个失败：${failures.slice(0, 3).join("；")}${failures.length > 3 ? " 等" : ""}。`,
        durationMs: 6000,
      });
      setChannelModels(failedDrafts.length > 0 ? failedDrafts : [{ ...initialModelDraft, upstream_protocol: selectedChannelProtocols[0] ?? "chat_completions", supported_protocols: [...selectedChannelProtocols] }]);
      if (successCount > 0) await loadChannels();
      return;
    }

    const response = await authedFetch(`/api/admin/models/${modelEditingId}`, {
      method: "PUT",
      body: JSON.stringify({
        ...modelForm,
        ...buildModelQuotaPayload(modelForm),
      }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新模型成功。") });
      setModelDrawerOpen(false);
      await loadChannels();
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
      await loadChannels();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新模型状态失败。") });
  }

  async function removeModel(id: number) {
    const response = await authedFetch(`/api/admin/models/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除模型成功。") });
      await loadChannels();
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

  const periodQuotaEnabled = modelGateFeatures.periodQuota;

  return {
    activeDraftProtocols,
    addChannelModelDraft,
    allModels,
    channelDrawerOpen,
    channelEditingId,
    channelForm,
    channelModels,
    channels,
    confirmUpstreamModelSelection: upstreamPicker.confirmUpstreamModelSelection,
    error,
    modelDrawerOpen,
    modelEditingId,
    modelForm,
    openCreateChannel,
    openCreateModel,
    openEditChannel,
    openEditModel,
    periodQuotaEnabled,
    probingModels: upstreamPicker.probingModels,
    probeUpstreamModels: upstreamPicker.probeUpstreamModels,
    removeChannel,
    removeChannelModelDraft,
    removeModel,
    selectedChannel,
    selectedChannelProtocols,
    selectFilteredUpstreamModels: upstreamPicker.selectFilteredUpstreamModels,
    setChannelDrawerOpen,
    setModelDrawerOpen,
    setUpstreamPickerOpen: upstreamPicker.setUpstreamPickerOpen,
    setUpstreamPickerQuery: upstreamPicker.setUpstreamPickerQuery,
    submitChannel,
    submitModel,
    testingModelId,
    testModel,
    toggleChannel,
    toggleModel,
    toggleUpstreamModel: upstreamPicker.toggleUpstreamModel,
    updateChannelForm,
    updateChannelModelDraft,
    updateModelChannel,
    updateModelForm,
    updateSupportedProtocols,
    upstreamModelOptions: upstreamPicker.upstreamModelOptions,
    upstreamPickerOpen: upstreamPicker.upstreamPickerOpen,
    upstreamPickerQuery: upstreamPicker.upstreamPickerQuery,
  };
}
