"use client";

import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { authedFetch } from "@/lib/auth/client-auth";
import { getApiMessage } from "@/lib/shared/api-message";
import {
  initialModelDraft,
  type ChannelModelDraft,
  type ModelRow,
  type Protocol,
  type UpstreamModelOption,
} from "./channel-model";

type UseUpstreamModelPickerArgs = {
  channelModels: ChannelModelDraft[];
  setChannelModels: Dispatch<SetStateAction<ChannelModelDraft[]>>;
  getDefaultProtocols: () => Protocol[];
};

export function useUpstreamModelPicker({
  channelModels,
  setChannelModels,
  getDefaultProtocols,
}: UseUpstreamModelPickerArgs) {
  const { toast } = useToast();
  const [probingModels, setProbingModels] = useState(false);
  const [upstreamPickerOpen, setUpstreamPickerOpen] = useState(false);
  const [upstreamPickerQuery, setUpstreamPickerQuery] = useState("");
  const [upstreamModelOptions, setUpstreamModelOptions] = useState<UpstreamModelOption[]>([]);

  async function probeUpstreamModels(baseUrl: string, apiKey: string | null, userAgent = "", proxyUrl = "", existingModels: ModelRow[] = []) {
    if (!baseUrl.trim()) {
      toast({ variant: "error", description: "请先填写 Base URL 与 API Key。" });
      return;
    }
    setProbingModels(true);
    try {
      const response = await authedFetch("/api/admin/channels/probe-models", {
        method: "POST",
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          api_key: (apiKey ?? "").trim(),
          user_agent: userAgent.trim(),
          proxy_url: proxyUrl.trim(),
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

  function confirmUpstreamModelSelection(protocols = getDefaultProtocols()) {
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

  return {
    confirmUpstreamModelSelection,
    probingModels,
    probeUpstreamModels,
    selectFilteredUpstreamModels,
    setUpstreamPickerOpen,
    setUpstreamPickerQuery,
    toggleUpstreamModel,
    upstreamModelOptions,
    upstreamPickerOpen,
    upstreamPickerQuery,
  };
}
