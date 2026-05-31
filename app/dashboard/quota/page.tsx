"use client";

import { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DashboardQuotaCard } from "../_home/dashboard-quota-card";
import { authedFetch } from "@/lib/auth/client-auth";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import type { QuotaData } from "../_home/dashboard-model";

type ModelQuota = {
  alias: string;
  real_model: string;
  quota_requests: number | null;
  quota_tokens: number | null;
  used_requests: number;
  used_tokens: number;
  remaining_requests: number | null;
  remaining_tokens: number | null;
  quota_period: number | null;
  period_label: string | null;
  period_quota_requests: number | null;
  period_quota_tokens: number | null;
  period_used_requests: number | null;
  period_used_tokens: number | null;
  period_remaining_requests: number | null;
  period_remaining_tokens: number | null;
  period_reset_at: string | null;
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

export default function QuotaPage() {
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [modelQuotas, setModelQuotas] = useState<ModelQuota[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [quotaRes, modelRes] = await Promise.all([
        authedFetch("/api/user/quota"),
        authedFetch("/api/user/model-quotas"),
      ]);
      if (cancelled) return;
      const quotaData = (await quotaRes.json().catch(() => null)) as { data?: QuotaData } | null;
      const modelData = (await modelRes.json().catch(() => null)) as { data?: ModelQuota[] } | null;
      if (quotaData?.data) setQuota(quotaData.data);
      if (modelData?.data) setModelQuotas(modelData.data);
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  return (
    <DashboardShell
      role="user"
      title="配额与限制"
      subtitle="查看当前账户的速率限制、配额使用情况。"
    >
      <div className="space-y-4 pb-6">
        <DashboardQuotaCard quota={quota} />

        {modelQuotas.length > 0 ? (
          <Card>
            <CardHeader>
              <SectionTitle title="模型独立配额" description="以下模型配置了独立配额，不受用户组限制约束。" />
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
                    {modelQuotas.map((m) => (
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
                          <QuotaBar used={m.used_requests} total={m.quota_requests} />
                        </TableCell>
                        <TableCell>
                          <TokenQuotaBar used={m.used_tokens} total={m.quota_tokens} />
                        </TableCell>
                        <TableCell>
                          {m.period_quota_requests != null ? (
                            <div className="space-y-1">
                              <Badge variant="outline" className="text-xs">{m.period_label}</Badge>
                              <QuotaBar used={m.period_used_requests ?? 0} total={m.period_quota_requests} />
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--color-foreground-muted)]">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {m.period_quota_tokens != null ? (
                            <div className="space-y-1">
                              <Badge variant="outline" className="text-xs">{m.period_label}</Badge>
                              <TokenQuotaBar used={m.period_used_tokens ?? 0} total={m.period_quota_tokens} />
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--color-foreground-muted)]">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {modelQuotas.some((m) => m.period_reset_at) ? (
                <p className="mt-2 text-xs text-[var(--color-foreground-muted)]">
                  周期配额重置时间：
                  {modelQuotas.filter((m) => m.period_reset_at).map((m) => (
                    <span key={m.alias} className="ml-2">
                      <span className="font-mono">{m.alias}</span> {new Date(m.period_reset_at!).toLocaleString()}
                    </span>
                  ))}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </DashboardShell>
  );
}
