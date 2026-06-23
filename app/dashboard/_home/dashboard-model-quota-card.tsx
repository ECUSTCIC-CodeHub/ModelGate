"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";

export type ModelQuotaItem = {
  alias: string;
  real_model: string;
  quota_mode: "bypass_group" | "independent";
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
        <SectionTitle title="不受账户限制的模型" description="以下模型不受账户速率限制和配额约束。独立配额模型使用自己的额度；绕过账户限制的模型则只受渠道侧限制。其余模型受账户限制，详情查看「配额与限制」页面。" />
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {modelQuotas.map((m) => (
            <div key={`${m.alias}:${m.real_model}`} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-medium text-[var(--color-foreground)]">{m.alias}</p>
                  {m.alias !== m.real_model ? (
                    <p className="truncate text-xs text-[var(--color-foreground-muted)]">({m.real_model})</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-foreground-muted)]">
                    {m.quota_mode === "independent" ? "独立配额" : "绕过"}
                  </span>
                  {m.period_label ? (
                    <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-foreground-muted)]">
                      {m.period_label}
                    </span>
                  ) : null}
                </div>
              </div>
              {m.quota_mode === "independent" ? (
                <div className="space-y-1">
                  {m.quota_requests !== null ? (
                    <QuotaBar used={m.used_requests} total={m.quota_requests} />
                  ) : null}
                  {m.quota_tokens !== null ? (
                    <TokenBar used={m.used_tokens} total={m.quota_tokens} />
                  ) : null}
                  {m.period_quota_requests !== null ? (
                    <QuotaBar used={m.period_used_requests ?? 0} total={m.period_quota_requests} />
                  ) : null}
                  {m.period_quota_tokens !== null ? (
                    <TokenBar used={m.period_used_tokens ?? 0} total={m.period_quota_tokens} />
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-[var(--color-foreground-muted)]">不受账户配额限制</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
