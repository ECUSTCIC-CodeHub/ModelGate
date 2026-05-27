"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch, ensureAdmin } from "@/lib/auth/client-auth";
import type { Channel } from "./channel-model";

type ChannelsResponse = {
  data?: Channel[];
  error?: { message?: string };
};

export function useChannelRecords() {
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState("");

  async function loadChannels() {
    if (!(await ensureAdmin(router))) return;

    const response = await authedFetch("/api/admin/channels");
    const data = (await response.json()) as ChannelsResponse;

    if (!response.ok) {
      setError(data.error?.message ?? "加载失败");
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
      const data = (await response.json()) as ChannelsResponse;
      if (!response.ok) {
        setError(data.error?.message ?? "加载失败");
        return;
      }
      setChannels(data.data ?? []);
    }
    void init();
    return () => { cancelled = true; };
  }, [router]);

  return {
    channels,
    error,
    loadChannels,
  };
}
