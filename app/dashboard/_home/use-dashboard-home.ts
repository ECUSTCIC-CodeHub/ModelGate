"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { authedFetch, clearSession, getCachedProfile, loginUrlWithNext, resolveAuthProfile } from "@/lib/auth/client-auth";
import type { QuotaData, Role, Summary } from "./dashboard-model";
import type { ModelQuotaItem } from "./dashboard-model-quota-card";

export function useDashboardHome() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [chartReady, setChartReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>(() => (initialProfile?.role as Role | undefined) ?? (getCachedProfile()?.role as Role | undefined) ?? "user");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [modelQuotas, setModelQuotas] = useState<ModelQuotaItem[]>([]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([resolveAuthProfile(), authedFetch(`/api/dashboard/summary?tz=${-new Date().getTimezoneOffset()}`), authedFetch("/api/user/quota"), authedFetch("/api/user/model-quotas")])
      .then(async ([resolution, summaryResp, quotaResp, modelQuotaResp]) => {
        if (cancelled) return;
        // 服务端暂时不可用时保留会话与缓存，不跳登录页，避免集中重登
        if (resolution.kind === "retryable") return;
        if (resolution.kind !== "ok") {
          clearSession();
          router.replace(loginUrlWithNext());
          return;
        }
        setRole(resolution.profile.role as Role);

        if (summaryResp.ok) {
          const summaryData = await summaryResp.json();
          if (!cancelled) setSummary(summaryData.data ?? null);
        }
        if (quotaResp.ok) {
          const quotaData = await quotaResp.json();
          if (!cancelled) setQuota(quotaData ?? null);
        }
        if (modelQuotaResp.ok) {
          const modelQuotaData = await modelQuotaResp.json();
          if (!cancelled) {
            const all = (modelQuotaData?.data ?? []) as Array<{ quota_mode: string }>;
            setModelQuotas(all.filter((m) => m.quota_mode === "independent" || m.quota_mode === "bypass_group" || m.quota_mode === "dual") as ModelQuotaItem[]);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return {
    chartReady,
    loading,
    modelQuotas,
    role,
    summary,
    quota,
  };
}
