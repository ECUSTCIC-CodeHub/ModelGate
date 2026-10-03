"use client";

import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import {
  MODELS_DEV_URL,
  parseModelsDevCatalog,
  protocolForModel,
  readModelsDevCache,
  writeModelsDevCache,
  type ModelsDevProviderInfo,
} from "./models-dev-catalog";
import { initialModelDraft, type ChannelModelDraft, type Protocol } from "./channel-model";

type UseModelsDevPrefillArgs = {
  setChannelModels: Dispatch<SetStateAction<ChannelModelDraft[]>>;
  defaultModelIsPublic: boolean;
};

export function useModelsDevPrefill({
  setChannelModels,
  defaultModelIsPublic,
}: UseModelsDevPrefillArgs) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<ModelsDevProviderInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function openPicker() {
    if (loading) return;
    const cached = readModelsDevCache();
    if (cached) {
      setProviders(cached);
      setPickerOpen(true);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(MODELS_DEV_URL);
      if (!response.ok) {
        toast({ variant: "error", description: `拉取 models.dev 目录失败（HTTP ${response.status}）。` });
        return;
      }
      const raw = await response.json().catch(() => null);
      const parsed = parseModelsDevCatalog(raw);
      if (parsed.length === 0) {
        toast({ variant: "error", description: "models.dev 目录格式无法识别或为空。" });
        return;
      }
      writeModelsDevCache(raw);
      setProviders(parsed);
      setPickerOpen(true);
    } catch {
      toast({ variant: "error", description: "拉取 models.dev 目录失败，请检查网络。" });
    } finally {
      setLoading(false);
    }
  }

  // 按所选模型各自的协议规则填入草稿，而不是一律套用 provider 首选协议
  function applyPrefill(selection: Array<{ provider: ModelsDevProviderInfo; modelId: string }>, fallbackProtocols: Protocol[]) {
    if (selection.length === 0) {
      toast({ variant: "error", description: "请选择至少一个要加入草稿的模型。" });
      return;
    }

    setChannelModels((prev) => {
      const filledFromPrev = prev.filter((model) => model.alias.trim() || model.real_model.trim());
      const existing = new Set(filledFromPrev.map((model) => model.real_model.trim()).filter(Boolean));
      const additions: ChannelModelDraft[] = [];

      for (const { provider, modelId } of selection) {
        if (existing.has(modelId)) continue;
        existing.add(modelId);
        const entry = provider.models.find((model) => model.id === modelId);
        const protocol = protocolForModel(
          { id: modelId, name: entry?.name, modalities: { output: entry?.outputModalities ?? [] } },
          provider.protocols.length > 0 ? provider.protocols : fallbackProtocols,
        );
        additions.push({
          ...initialModelDraft,
          alias: modelId,
          real_model: modelId,
          is_public: defaultModelIsPublic,
          upstream_protocol: protocol,
          supported_protocols: [protocol],
        });
      }

      if (additions.length === 0) return prev;
      const merged = [...filledFromPrev, ...additions];
      return merged.length > 0
        ? merged
        : [{ ...initialModelDraft, is_public: defaultModelIsPublic, upstream_protocol: fallbackProtocols[0] ?? "chat_completions" }];
    });

    setPickerOpen(false);
    toast({ variant: "success", description: `已从 models.dev 加入 ${selection.length} 个模型草稿。` });
  }

  return {
    applyPrefill,
    loading,
    openPicker,
    pickerOpen,
    providers,
    setPickerOpen,
  };
}
