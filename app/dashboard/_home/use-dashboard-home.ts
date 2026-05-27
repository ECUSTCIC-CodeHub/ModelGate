"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/auth/client-auth";
import type { QuotaData, Role, Summary } from "./dashboard-model";

export function useDashboardHome() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [chartReady, setChartReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>(() => (initialProfile?.role as Role | undefined) ?? (getCachedProfile()?.role as Role | undefined) ?? "user");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [quota, setQuota] = useState<QuotaData | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([getOrFetchProfile(), authedFetch("/api/dashboard/summary"), authedFetch("/api/user/quota")])
      .then(async ([profile, summaryResp, quotaResp]) => {
        if (cancelled) return;
        if (!profile) {
          clearSession();
          router.replace("/login");
          return;
        }
        setRole(profile.role as Role);

        if (summaryResp.ok) {
          const summaryData = await summaryResp.json();
          if (!cancelled) setSummary(summaryData.data ?? null);
        }
        if (quotaResp.ok) {
          const quotaData = await quotaResp.json();
          if (!cancelled) setQuota(quotaData ?? null);
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
    role,
    summary,
    quota,
  };
}
