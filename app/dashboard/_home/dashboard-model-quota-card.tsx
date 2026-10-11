"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import type { PeriodQuotaEntry } from "@/lib/gateway/quota";

export type ModelQuotaItem = {
  alias: string;
  real_model: string;
  channel_id: number;
  channel_name: string;
  quota_mode: "bypass_group" | "independent" | "dual";
  quota_requests: number | null;
  quota_tokens: number | null;
  used_requests: number | null;
  used_tokens: number | null;
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
  periods?: PeriodQuotaEntry[];
  effective_token_multiplier?: number;
  effective_request_multiplier?: number;
  multiplier_schedule_applied?: boolean;
};

function QuotaBar({ used, total }: { used: number; total: number | null }) {
  if (total === null || total <= 0) return <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
        <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-[var(--color-foreground-muted)]">{formatNumber(used)}/{formatNumber(total)}</span>
    </div>
  );
}

function TokenBar({ used, total }: { used: number; total: number | null }) {
  if (total === null || total <= 0) return <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
        <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-[var(--color-foreground-muted)]">{formatTokenCount(used)}/{formatTokenCount(total)}</span>
    </div>
  );
}

export function DashboardModelQuotaCard({ modelQuotas }: { modelQuotas: ModelQuotaItem[] }) {
  if (modelQuotas.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <SectionTitle title="特殊配额模型" description="绕过账户限制或配置模型自身配额的模型。独立配额与双重限制模型使用模型自身额度；双重限制模式同时受用户组配额约束；绕过账户限制的模型不受账户配额和速率限制。" />
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {modelQuotas.map((m) => {
            const independent = m.quota_mode === "independent" || m.quota_mode === "dual";
            const cycles = m.periods ?? [];
            return (
              <div key={`${m.alias}:${m.channel_id}`} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate font-mono text-sm font-medium text-[var(--color-foreground)]"
                      title={m.alias !== m.real_model ? `${m.alias} (${m.real_model})` : m.alias}
                    >
                      {m.alias}
                      {m.alias !== m.real_model ? (
                        <span className="text-xs text-[var(--color-foreground-muted)]"> ({m.real_model})</span>
                      ) : null}
                    </p>
                    {m.channel_name ? (
                      <p className="truncate text-xs text-[var(--color-foreground-muted)]">{m.channel_name}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-foreground-muted)]">
                      {m.quota_mode === "independent" ? "独立配额" : m.quota_mode === "dual" ? "双重限制" : "绕过"}
                    </span>
                    {m.multiplier_schedule_applied ? (
                      <span
                        className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-foreground-muted)]"
                        title="当前时段命中分时倍率"
                      >
                        分时
                      </span>
                    ) : null}
                    {independent && cycles.length === 0 && m.period_label ? (
                      <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-foreground-muted)]">
                        {m.period_label}
                      </span>
                    ) : null}
                  </div>
                </div>
                {independent ? (
                  <div className="space-y-1">
                    {m.multiplier_schedule_applied ? (
                      <p className="text-xs text-[var(--color-foreground-muted)]">
                        生效倍率 T {m.effective_token_multiplier ?? 1}x / R {m.effective_request_multiplier ?? 1}x
                      </p>
                    ) : null}
                    {m.quota_requests === null && m.quota_tokens === null && cycles.length === 0 && m.period_quota_requests === null && m.period_quota_tokens === null ? (
                      <p className="text-xs text-[var(--color-foreground-muted)]">未配置模型配额</p>
                    ) : (
                      <>
                        {m.quota_requests !== null ? (
                          <QuotaBar used={m.used_requests ?? 0} total={m.quota_requests} />
                        ) : null}
                        {m.quota_tokens !== null ? (
                          <TokenBar used={m.used_tokens ?? 0} total={m.quota_tokens} />
                        ) : null}
                        {cycles.length > 0
                          ? cycles.map((entry) => (
                              <div key={entry.id} className="space-y-1 pt-1">
                                <Badge variant="outline" className="text-xs">{entry.period_label}</Badge>
                                {entry.quota_requests !== null ? (
                                  <QuotaBar used={entry.used_requests} total={entry.quota_requests} />
                                ) : null}
                                {entry.quota_tokens !== null ? (
                                  <TokenBar used={entry.used_tokens} total={entry.quota_tokens} />
                                ) : null}
                                {entry.quota_requests === null && entry.quota_tokens === null ? (
                                  <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>
                                ) : null}
                              </div>
                            ))
                          : (
                            <>
                              {m.period_quota_requests !== null ? (
                                <QuotaBar used={m.period_used_requests ?? 0} total={m.period_quota_requests} />
                              ) : null}
                              {m.period_quota_tokens !== null ? (
                                <TokenBar used={m.period_used_tokens ?? 0} total={m.period_quota_tokens} />
                              ) : null}
                            </>
                          )}
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--color-foreground-muted)]">不受账户配额限制</p>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
