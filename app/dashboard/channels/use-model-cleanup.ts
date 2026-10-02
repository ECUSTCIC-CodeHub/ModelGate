"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { authedFetch } from "@/lib/auth/client-auth";
import { getApiMessage } from "@/lib/shared/api-message";
import { parseSupportedProtocols, type Channel, type Protocol, type StaleModelsResult } from "./channel-model";

type CleanupPreview = {
  channelId: number;
  channelName: string;
  protocols: Protocol[];
  result: StaleModelsResult;
};

export function useModelCleanup({
  channels,
  loadChannels,
}: {
  channels: Channel[];
  loadChannels: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [probingChannelId, setProbingChannelId] = useState<number | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [selectedStaleIds, setSelectedStaleIds] = useState<Set<number>>(new Set());
  const [deletingCleanup, setDeletingCleanup] = useState(false);

  async function startCleanup(channelId: number) {
    if (probingChannelId !== null) return;
    const channel = channels.find((item) => item.id === channelId);
    if (!channel) {
      toast({ variant: "error", description: "渠道不存在，请刷新页面后重试。" });
      return;
    }

    setProbingChannelId(channelId);
    try {
      const response = await authedFetch(`/api/admin/channels/${channelId}/prune-models`, {
        method: "POST",
        body: JSON.stringify({ dry_run: true }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "探测上游模型失败。") });
        return;
      }

      const result = data?.data as StaleModelsResult | undefined;
      if (!result) {
        toast({ variant: "error", description: "探测结果解析失败。" });
        return;
      }
      if (result.stale.length === 0) {
        toast({ variant: "info", description: `上游 ${result.upstream_count} 个模型与本地一致，无需清理。` });
        return;
      }

      setCleanupPreview({
        channelId,
        channelName: result.channel_name || channel.name,
        protocols: parseSupportedProtocols(channel.supported_protocols),
        result,
      });
      setSelectedStaleIds(new Set(result.stale.map((item) => item.id)));
    } finally {
      setProbingChannelId(null);
    }
  }

  function closeCleanupDialog() {
    if (deletingCleanup) return;
    setCleanupPreview(null);
    setSelectedStaleIds(new Set());
  }

  function toggleStaleModel(id: number, selected: boolean) {
    setSelectedStaleIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectStaleModels(ids: number[], selected: boolean) {
    setSelectedStaleIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function confirmCleanup() {
    const preview = cleanupPreview;
    if (!preview || deletingCleanup) return;

    const ids = preview.result.stale.filter((item) => selectedStaleIds.has(item.id)).map((item) => item.id);
    if (ids.length === 0) {
      toast({ variant: "error", description: "请至少勾选一个要删除的模型。" });
      return;
    }

    setDeletingCleanup(true);
    try {
      const response = await authedFetch(`/api/admin/channels/${preview.channelId}/prune-models`, {
        method: "POST",
        body: JSON.stringify({ dry_run: false, ids }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "清理模型失败。") });
        return;
      }

      const payload = data?.data as { deleted?: number; aliases_cleaned?: number } | undefined;
      const deleted = payload?.deleted ?? ids.length;
      const aliasesCleaned = payload?.aliases_cleaned ?? 0;

      toast({
        variant: "success",
        description:
          aliasesCleaned > 0
            ? `已清理 ${deleted} 个模型，${aliasesCleaned} 个别名已从用户组/用户白名单移除。`
            : `已清理 ${deleted} 个模型。`,
        durationMs: 6000,
      });

      setCleanupPreview(null);
      setSelectedStaleIds(new Set());
      await loadChannels();
    } finally {
      setDeletingCleanup(false);
    }
  }

  return {
    cleanupPreview,
    closeCleanupDialog,
    confirmCleanup,
    deletingCleanup,
    probingChannelId,
    selectStaleModels,
    selectedStaleIds,
    startCleanup,
    toggleStaleModel,
  };
}
