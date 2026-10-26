"use client";

import { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DashboardQuotaCard } from "../_home/dashboard-quota-card";
import { DashboardAdminQuotaCard, type AdminQuotaOverview } from "../_home/dashboard-admin-quota-card";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { authedFetch, getCachedProfile, getOrFetchProfile } from "@/lib/auth/client-auth";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import type { PeriodQuotaEntry } from "@/lib/gateway/quota";
import type { QuotaData } from "../_home/dashboard-model";

type ModelQuota = {
  alias: string;
  real_model: string;
  quota_mode: "follow_group" | "bypass_group" | "independent" | "dual";
  token_multiplier: number;
  request_multiplier: number;
  quota_requests: number | null;
  quota_tokens: number | null;
  used_requests: number | null;
  used_tokens: number | null;
  remaining_requests: number | null;
  remaining_tokens: number | null;
  periods?: PeriodQuotaEntry[];
  effective_token_multiplier?: number;
  effective_request_multiplier?: number;
  multiplier_schedule_applied?: boolean;
};

function QuotaBar({ used, total }: { used: number; total: number | null }) {
  if (total === null || total <= 0) return <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--color-foreground-muted)]">{formatNumber(used)}</span>
        <span className="text-[var(--color-foreground-muted)]">{formatNumber(total)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function TokenQuotaBar({ used, total }: { used: number; total: number | null }) {
  if (total === null || total <= 0) return <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--color-foreground-muted)]">{formatTokenCount(used)}</span>
        <span className="text-[var(--color-foreground-muted)]">{formatTokenCount(total)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-accent)] transition-all">
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// 额度 -1 是显式不限制（没有进度条），null 是该周期未配置。
function limitedEntries(cycles: PeriodQuotaEntry[], key: "quota_requests" | "quota_tokens") {
  return cycles.filter((entry) => entry[key] !== null && entry[key] >= 0);
}

function ModelPeriodRequests({ model }: { model: ModelQuota }) {
  const cycles = model.periods ?? [];
  const limited = limitedEntries(cycles, "quota_requests");
  if (limited.length === 0) {
    return cycles.length === 0
      ? <span className="text-xs text-[var(--color-foreground-muted)]">-</span>
      : <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>;
  }

  return (
    <div className="space-y-1">
      {limited.map((entry) => (
        <div key={entry.id} className="space-y-1">
          <Badge variant="outline" className="text-xs">{entry.period_label}</Badge>
          <QuotaBar used={entry.used_requests} total={entry.quota_requests} />
        </div>
      ))}
    </div>
  );
}

function ModelPeriodTokens({ model }: { model: ModelQuota }) {
  const cycles = model.periods ?? [];
  const limited = limitedEntries(cycles, "quota_tokens");
  if (limited.length === 0) {
    return cycles.length === 0
      ? <span className="text-xs text-[var(--color-foreground-muted)]">-</span>
      : <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>;
  }

  return (
    <div className="space-y-1">
      {limited.map((entry) => (
        <div key={entry.id} className="space-y-1">
          <Badge variant="outline" className="text-xs">{entry.period_label}</Badge>
          <TokenQuotaBar used={entry.used_tokens} total={entry.quota_tokens} />
        </div>
      ))}
    </div>
  );
}

function UserQuotaContent({ quota, modelQuotas }: { quota: QuotaData | null; modelQuotas: ModelQuota[] }) {
  const independentModels = modelQuotas.filter((m) => m.quota_mode === "independent" || m.quota_mode === "dual");
  const bypassModels = modelQuotas.filter((m) => m.quota_mode === "bypass_group");

  const resetEntries = independentModels.flatMap((m) =>
    (m.periods ?? [])
      .filter((entry) => entry.reset_at)
      .map((entry) => ({ key: `${m.alias}:${entry.id}`, alias: m.alias, label: entry.period_label, resetAt: entry.reset_at as string })),
  );

  return (
    <div className="space-y-4 pb-6">
      <DashboardQuotaCard quota={quota} />

      {independentModels.length > 0 ? (
        <Card>
          <CardHeader>
            <SectionTitle title="模型自身配额" description="以下模型配置了模型自身配额；其中双重限制模式的模型同时受用户组配额与速率限制约束。" />
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead>请求配额</TableHead>
                    <TableHead>Token 配额</TableHead>
                    <TableHead>周期请求配额</TableHead>
                    <TableHead>周期 Token 配额</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {independentModels.map((m) => (
                    <TableRow key={`${m.alias}:${m.real_model}`}>
                      <TableCell>
                        <div>
                          <span className="font-mono text-sm">{m.alias}</span>
                          {m.alias !== m.real_model ? (
                            <span className="ml-2 text-xs text-[var(--color-foreground-muted)]">({m.real_model})</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <QuotaBar used={m.used_requests ?? 0} total={m.quota_requests} />
                      </TableCell>
                      <TableCell>
                        <TokenQuotaBar used={m.used_tokens ?? 0} total={m.quota_tokens} />
                      </TableCell>
                      <TableCell>
                        <ModelPeriodRequests model={m} />
                      </TableCell>
                      <TableCell>
                        <ModelPeriodTokens model={m} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {resetEntries.length > 0 ? (
              <p className="mt-2 text-xs text-[var(--color-foreground-muted)]">
                周期配额重置时间：
                {resetEntries.map((entry) => (
                  <span key={entry.key} className="ml-2">
                    <span className="font-mono">{entry.alias}</span>
                    {entry.label ? ` ${entry.label}` : ""} {new Date(entry.resetAt).toLocaleString()}
                  </span>
                ))}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {bypassModels.length > 0 ? (
        <Card>
          <CardHeader>
            <SectionTitle title="绕过用户组限制的模型" description="以下模型不受用户组配额和速率限制约束，使用量仍计入账户总用量，但配额检查仅受渠道侧或模型自身限制。" />
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <Table className="min-w-[400px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead>配额模式</TableHead>
                    <TableHead>说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bypassModels.map((m) => (
                    <TableRow key={`${m.alias}:${m.real_model}`}>
                      <TableCell>
                        <div>
                          <span className="font-mono text-sm">{m.alias}</span>
                          {m.alias !== m.real_model ? (
                            <span className="ml-2 text-xs text-[var(--color-foreground-muted)]">({m.real_model})</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">绕过用户组</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-[var(--color-foreground-muted)]">不受用户组配额与速率限制，使用量计入账户总用量</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default function QuotaPage() {
  const initialProfile = useAuthProfile();
  const [role, setRole] = useState<"admin" | "user">(() => (initialProfile?.role as "admin" | "user" | undefined) ?? (getCachedProfile()?.role as "admin" | "user" | undefined) ?? "user");
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [modelQuotas, setModelQuotas] = useState<ModelQuota[]>([]);
  const [adminOverview, setAdminOverview] = useState<AdminQuotaOverview | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const profile = await getOrFetchProfile();
      if (cancelled) return;

      if (!profile) {
        if (!cancelled) setLoading(false);
        return;
      }

      const userRole = profile.role as "admin" | "user";
      setRole(userRole);

      if (userRole === "admin") {
        const res = await authedFetch("/api/admin/quota-overview");
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (!cancelled && data) setAdminOverview(data);
        }
      } else {
        const [quotaRes, modelRes] = await Promise.all([
          authedFetch("/api/user/quota"),
          authedFetch("/api/user/model-quotas"),
        ]);
        if (cancelled) return;
        const quotaData = (await quotaRes.json().catch(() => null)) as QuotaData | null;
        const modelData = (await modelRes.json().catch(() => null)) as { data?: ModelQuota[] } | null;
        if (quotaData) setQuota(quotaData);
        if (modelData?.data) setModelQuotas(modelData.data);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, []);

  if (role === "admin") {
    return (
      <DashboardShell
        role="admin"
        title="配额与限制"
        subtitle="系统全局配额概览，查看各用户组和特殊模型的配额使用情况。"
      >
        {loading ? null : <DashboardAdminQuotaCard overview={adminOverview} />}
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      role="user"
      title="配额与限制"
      subtitle="查看当前账户的速率限制、配额使用情况。"
    >
      {loading ? null : <UserQuotaContent quota={quota} modelQuotas={modelQuotas} />}
    </DashboardShell>
  );
}
