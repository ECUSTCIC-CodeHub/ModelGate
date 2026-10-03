"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
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
import { useModelCleanup } from "./use-model-cleanup";
import { useUpstreamModelPicker } from "./use-upstream-model-picker";
import { useModelsDevPrefill } from "./use-models-dev-prefill";

function expiresAtToInputValue(value: unknown): string {
  // 后端返回 UTC（带 Z 的 ISO 或裸 UTC 串），datetime-local 控件需要浏览器本地墙上时间。
  const date = value instanceof Date ? value : typeof value === "string" && value ? new Date(value.includes("T") ? value : value.replace(" ", "T")) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// datetime-local 输出的是浏览器本地墙上时间（无时区），转成带 Z 的 ISO 提交，由后端按绝对时刻存储为 UTC。
function expiresAtFromInputValue(value: string): string {
  if (!value.trim()) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

// 表单里按「每行 Name: Value」编辑，落库是 JSON 字符串
function formatCustomHeadersInput(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .map(([name, value]) => `${name}: ${value as string}`)
      .join("\n");
  } catch {
    return "";
  }
}

// 解析失败返回 {} 会让用户以为保存成功却清空了配置，故返回 null 由调用方拦下；
// 保留原始对象的键序以便与后端一致地报出首个非法项
function parseCustomHeadersInput(value: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separatorAt = trimmed.indexOf(":");
    if (separatorAt <= 0) return null;
    headers[trimmed.slice(0, separatorAt).trim()] = trimmed.slice(separatorAt + 1).trim();
  }
  return headers;
}

// 保留入参顺序的受限并发映射
async function runWithConcurrencyLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function useChannelAdmin() {
  const { toast } = useToast();
  const { channels, error, loadChannels } = useChannelRecords();
  const [testingModelId, setTestingModelId] = useState<number | null>(null);

  const [channelDrawerOpen, setChannelDrawerOpen] = useState(false);
  const [channelEditingId, setChannelEditingId] = useState<number | null>(null);
  const [channelEditingCanViewApiKey, setChannelEditingCanViewApiKey] = useState(false);
  const [channelEditingCanManagePrivacy, setChannelEditingCanManagePrivacy] = useState(true);
  const [channelEditingHasStoredApiKey, setChannelEditingHasStoredApiKey] = useState(false);
  const [channelForm, setChannelForm] = useState<ChannelForm>(initialChannelForm);
  const [defaultModelIsPublic, setDefaultModelIsPublic] = useState(true);
  const [channelModels, setChannelModels] = useState<ChannelModelDraft[]>([baseDraft(channelForm.supported_protocols)]);

  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [modelEditingId, setModelEditingId] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(initialModelForm);

  const upstreamPicker = useUpstreamModelPicker({
    channelModels,
    setChannelModels,
    getDefaultProtocols: () => channelForm.supported_protocols,
    defaultModelIsPublic,
  });

  const modelsDev = useModelsDevPrefill({
    channelModels,
    setChannelModels,
    defaultModelIsPublic,
  });

  const modelCleanup = useModelCleanup({ channels, loadChannels });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await authedFetch("/api/admin/settings");
      const payload = await response.json().catch(() => null);
      if (cancelled || !response.ok || !payload?.data || typeof payload.data !== "object") return;
      setDefaultModelIsPublic(payload.data.default_model_is_public !== 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function baseDraft(protocols: Protocol[]): ChannelModelDraft {
    return {
      ...initialModelDraft,
      is_public: defaultModelIsPublic,
      upstream_protocol: protocols[0] ?? "chat_completions",
      supported_protocols: [...protocols],
    };
  }

  function openCreateChannel() {
    setChannelEditingId(null);
    setChannelEditingCanViewApiKey(true);
    setChannelEditingCanManagePrivacy(true);
    setChannelEditingHasStoredApiKey(false);
    setChannelForm({ ...initialChannelForm });
    setChannelModels([baseDraft(initialChannelForm.supported_protocols)]);
    setChannelDrawerOpen(true);
  }

  function openEditChannel(row: Channel) {
    const supportedProtocols = parseSupportedProtocols(row.supported_protocols);
    setChannelEditingId(row.id);
    setChannelEditingCanViewApiKey(row.can_view_api_key === true);
    setChannelEditingCanManagePrivacy(row.can_manage_api_key_privacy === true);
    setChannelEditingHasStoredApiKey(row.can_view_api_key === true && (row.api_key ?? "") !== "");
    setChannelForm({
      name: row.name,
      base_url: row.base_url,
      api_key: row.can_view_api_key ? (row.api_key ?? "") : "",
      api_key_private: row.api_key_private === 1,
      user_agent: row.user_agent ?? "",
      proxy_url: row.proxy_url ?? "",
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
      ua_restrictions: row.ua_restrictions ?? "",
      expires_at: expiresAtToInputValue(row.expires_at),
      time_restrictions: row.time_restrictions ?? "",
      custom_headers: formatCustomHeadersInput(row.custom_headers),
      group_name: row.group_name ?? "",
    });
    setChannelModels([baseDraft(supportedProtocols)]);
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
    setChannelModels((prev) => [...prev, baseDraft(protocols)]);
  }

  function importChannelModelDrafts(names: string[], protocols: Protocol[]) {
    const trimmed = names.map((name) => name.trim()).filter(Boolean);
    if (trimmed.length === 0) {
      toast({ variant: "info", description: "没有可导入的模型名。" });
      return;
    }
    const existing = new Set(channelModels.map((draft) => draft.alias.trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    const added: ChannelModelDraft[] = [];
    let skipped = 0;
    for (const name of trimmed) {
      const key = name.toLowerCase();
      if (seen.has(key) || existing.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      added.push({
        ...baseDraft(protocols),
        alias: name,
        real_model: name,
      });
    }
    if (added.length === 0) {
      toast({ variant: "info", description: `全部为重复别名，已跳过 ${skipped} 个，无新增。` });
      return;
    }
    setChannelModels((prev) => {
      const withoutBlanks = prev.filter((draft) => draft.alias.trim() !== "" || draft.real_model.trim() !== "");
      return [...withoutBlanks, ...added];
    });
    const parts = [`已添加 ${added.length} 个模型`];
    if (skipped > 0) parts.push(`${skipped} 个重复已跳过`);
    toast({ variant: "success", description: `${parts.join("，")}。` });
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

    const customHeaders = parseCustomHeadersInput(channelForm.custom_headers);
    if (customHeaders === null) {
      toast({ variant: "error", description: "自定义 Header 需按「名称: 值」每行一条填写。" });
      return;
    }

    if (channelEditingId === null) {
      const draftModels = channelModels
        .map((item) => ({
          alias: item.alias.trim(),
          real_model: item.real_model.trim(),
          upstream_protocol: item.upstream_protocol,
          supported_protocols: item.supported_protocols,
          copilot_compatibility: item.copilot_compatibility,
          is_public: item.is_public,
          enabled: item.enabled,
          weight: item.weight,
          token_multiplier: item.token_multiplier,
          request_multiplier: item.request_multiplier,
          max_concurrency: item.max_concurrency,
          quota_mode: item.quota_mode,
        }))
        .filter((item) => item.alias && item.real_model);

      const response = await authedFetch("/api/admin/channels", {
        method: "POST",
        body: JSON.stringify({
          name: channelForm.name,
          base_url: channelForm.base_url,
          api_key: channelForm.api_key,
          api_key_private: channelForm.api_key_private,
          user_agent: channelForm.user_agent,
          proxy_url: channelForm.proxy_url,
          supported_protocols: channelForm.supported_protocols,
          weight: channelForm.weight,
          max_concurrency: channelForm.max_concurrency,
          timeout: channelForm.timeout,
          force_include_usage: channelForm.force_include_usage,
          ua_restrictions: channelForm.ua_restrictions,
          expires_at: expiresAtFromInputValue(channelForm.expires_at),
          time_restrictions: channelForm.time_restrictions,
          custom_headers: customHeaders,
          group_name: channelForm.group_name.trim(),
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

    const updateBody: Record<string, unknown> = {
      name: channelForm.name,
      base_url: channelForm.base_url,
      user_agent: channelForm.user_agent,
      proxy_url: channelForm.proxy_url,
      supported_protocols: channelForm.supported_protocols,
      weight: channelForm.weight,
      max_concurrency: channelForm.max_concurrency,
      timeout: channelForm.timeout,
      force_include_usage: channelForm.force_include_usage,
      ua_restrictions: channelForm.ua_restrictions,
      expires_at: expiresAtFromInputValue(channelForm.expires_at),
      time_restrictions: channelForm.time_restrictions,
      custom_headers: customHeaders,
      group_name: channelForm.group_name.trim(),
      ...buildQuotaPayload(channelForm),
    };
    if (channelEditingCanViewApiKey) updateBody.api_key = channelForm.api_key;
    if (channelEditingCanManagePrivacy) updateBody.api_key_private = channelForm.api_key_private;

    const response = await authedFetch(`/api/admin/channels/${channelEditingId}`, {
      method: "PUT",
      body: JSON.stringify(updateBody),
    });
    const data = await response.json().catch(() => null);

    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新渠道成功。") });
      setChannelDrawerOpen(false);
      // 抽屉关闭后状态不能停留在提交前的值：否则再次提交同一渠道时，
      // 清空密钥的二次确认会依据过期的"是否已存密钥"漏弹或误弹
      setChannelEditingHasStoredApiKey(false);
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
    setChannelModels([baseDraft(supportedProtocols)]);
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
      supports_vision: row.supports_vision === 1,
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
      ua_restrictions: row.ua_restrictions ?? "",
      expires_at: expiresAtToInputValue(row.expires_at),
      system_prompt: row.system_prompt ?? "",
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
      setChannelModels([baseDraft(protocols)]);
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
          supports_vision: item.supports_vision,
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
              supports_vision: draft.supports_vision,
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
            supports_vision: draft.supports_vision,
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
      setChannelModels(failedDrafts.length > 0 ? failedDrafts : [baseDraft(selectedChannelProtocols)]);
      if (successCount > 0) await loadChannels();
      return;
    }

    const response = await authedFetch(`/api/admin/models/${modelEditingId}`, {
      method: "PUT",
      body: JSON.stringify({
        ...modelForm,
        expires_at: expiresAtFromInputValue(modelForm.expires_at),
        ua_restrictions: modelForm.ua_restrictions,
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

  // 批量操作逐条调用既有单条接口：模型更新/删除都带渠道启用级联与配额副作用，
  // 走同一入口可避免在此重复实现一套规则；并发受限以免打满连接池
  async function bulkSetModelEnabled(ids: number[], enabled: boolean) {
    if (ids.length === 0) return;
    const results = await runWithConcurrencyLimit(ids, 5, async (id) => {
      const response = await authedFetch(`/api/admin/models/${id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      return response.ok;
    });
    const okCount = results.filter(Boolean).length;
    const failed = results.length - okCount;
    if (okCount > 0) await loadChannels();
    toast({
      variant: failed > 0 ? "error" : "success",
      description:
        failed > 0
          ? `已${enabled ? "启用" : "禁用"} ${okCount} 个模型，${failed} 个失败。`
          : `已${enabled ? "启用" : "禁用"} ${okCount} 个模型。`,
    });
  }

  async function bulkRemoveModels(ids: number[]) {
    if (ids.length === 0) return;
    const results = await runWithConcurrencyLimit(ids, 5, async (id) => {
      const response = await authedFetch(`/api/admin/models/${id}`, { method: "DELETE" });
      return response.ok;
    });
    const okCount = results.filter(Boolean).length;
    const failed = results.length - okCount;
    if (okCount > 0) await loadChannels();
    toast({
      variant: failed > 0 ? "error" : "success",
      description: failed > 0 ? `已删除 ${okCount} 个模型，${failed} 个失败。` : `已删除 ${okCount} 个模型。`,
    });
  }

  const allModels: ModelWithChannel[] = channels.flatMap((channel) =>
    (channel.models ?? []).map((model) => ({
      ...model,
      channel_name: channel.name,
      channel_weight: channel.weight,
      channel_enabled: channel.enabled,
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
    bulkRemoveModels,
    bulkSetModelEnabled,
    importChannelModelDrafts,
    channelDrawerOpen,
    channelEditingId,
    channelEditingCanViewApiKey,
    channelEditingCanManagePrivacy,
    channelEditingHasStoredApiKey,
    channelForm,
    channelModels,
    channels,
    cleanupPreview: modelCleanup.cleanupPreview,
    closeCleanupDialog: modelCleanup.closeCleanupDialog,
    confirmCleanup: modelCleanup.confirmCleanup,
    confirmUpstreamModelSelection: upstreamPicker.confirmUpstreamModelSelection,
    deletingCleanup: modelCleanup.deletingCleanup,
    error,
    modelDrawerOpen,
    modelEditingId,
    modelForm,
    modelsDevApplyPrefill: modelsDev.applyPrefill,
    modelsDevLoading: modelsDev.loading,
    modelsDevOpenPicker: modelsDev.openPicker,
    modelsDevPickerOpen: modelsDev.pickerOpen,
    modelsDevProviders: modelsDev.providers,
    modelsDevSetPickerOpen: modelsDev.setPickerOpen,
    openCreateChannel,
    openCreateModel,
    openEditChannel,
    openEditModel,
    periodQuotaEnabled,
    probingChannelIds: modelCleanup.probingChannelIds,
    probingModels: upstreamPicker.probingModels,
    probeUpstreamModels: upstreamPicker.probeUpstreamModels,
    removeChannel,
    removeChannelModelDraft,
    removeModel,
    selectedChannel,
    selectedChannelProtocols,
    selectedStaleIds: modelCleanup.selectedStaleIds,
    selectFilteredUpstreamModels: upstreamPicker.selectFilteredUpstreamModels,
    selectStaleModels: modelCleanup.selectStaleModels,
    setChannelDrawerOpen,
    setModelDrawerOpen,
    setUpstreamPickerOpen: upstreamPicker.setUpstreamPickerOpen,
    setUpstreamPickerQuery: upstreamPicker.setUpstreamPickerQuery,
    startCleanup: modelCleanup.startCleanup,
    submitChannel,
    submitModel,
    testingModelId,
    testModel,
    toggleChannel,
    toggleModel,
    toggleStaleModel: modelCleanup.toggleStaleModel,
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
