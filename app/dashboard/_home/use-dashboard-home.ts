"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { authedFetch, clearSession, getCachedProfile, getOrFetchProfile } from "@/lib/auth/client-auth";
import type { QuotaData, Role, Summary } from "./dashboard-model";
import type { ModelQuotaItem } from "./dashboard-model-quota-card";
import type { AdminQuotaOverview } from "./dashboard-admin-quota-card";

export function useDashboardHome() {
  const router = useRouter();
  const initialProfile = useAuthProfile();
  const [chartReady, setChartReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>(() => (initialProfile?.role as Role | undefined) ?? (getCachedProfile()?.role as Role | undefined) ?? "user");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [modelQuotas, setModelQuotas] = useState<ModelQuotaItem[]>([]);
  const [adminQuotaOverview, setAdminQuotaOverview] = useState<AdminQuotaOverview | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void getOrFetchProfile().then((profile) => {
      if (cancelled) return;
      if (!profile) {
        clearSession();
        router.replace("/login");
        return;
      }
      const userRole = profile.role as Role;
      setRole(userRole);

      const isAdmin = userRole === "admin";
      const apis = isAdmin
        ? Promise.all([
            authedFetch("/api/dashboard/summary"),
            authedFetch("/api/admin/quota-overview"),
          ])
        : Promise.all([
            authedFetch("/api/dashboard/summary"),
            authedFetch("/api/user/quota"),
            authedFetch("/api/user/model-quotas"),
          ]);

      void apis.then(async (responses) => {
        if (cancelled) return;

        const [summaryResp] = responses;
        if (summaryResp.ok) {
          const summaryData = await summaryResp.json();
          if (!cancelled) setSummary(summaryData.data ?? null);
        }

        if (isAdmin) {
          const [, adminQuotaResp] = responses;
          if (adminQuotaResp && adminQuotaResp.ok) {
            const adminQuotaData = await adminQuotaResp.json();
            if (!cancelled) setAdminQuotaOverview(adminQuotaData ?? null);
          }
        } else {
          const [, quotaResp, modelQuotaResp] = responses as [Response, Response, Response];
          if (quotaResp.ok) {
            const quotaData = await quotaResp.json();
            if (!cancelled) setQuota(quotaData ?? null);
          }
          if (modelQuotaResp.ok) {
            const modelQuotaData = await modelQuotaResp.json();
            if (!cancelled) setModelQuotas(modelQuotaData?.data ?? []);
          }
        }
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return {
    adminQuotaOverview,
    chartReady,
    loading,
    modelQuotas,
    role,
    summary,
    quota,
  };
}
