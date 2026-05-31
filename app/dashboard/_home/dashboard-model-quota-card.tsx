"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";

export type ModelQuotaItem = {
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
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
        <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-[var(--color-foreground-muted)]">{formatNumber(used)} / {formatNumber(total)}</p>
    </div>
  );
}

function TokenBar({ used, total }: { used: number; total: number | null }) {
  if (total === null || total <= 0) return <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>;
  const pct = Math.min(100, (used / total) * 100);
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
        <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-[var(--color-foreground-muted)]">{formatTokenCount(used)} / {formatTokenCount(total)}</p>
    </div>
  );
}

export function DashboardModelQuotaCard({ modelQuotas }: { modelQuotas: ModelQuotaItem[] }) {
  if (modelQuotas.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <SectionTitle title="模型独立配额" description="以下模型配置了独立配额，不受账户速率限制和配额约束。其余模型受账户限制，详情查看「配额与限制」页面。" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {modelQuotas.map((m) => (
            <div key={`${m.alias}:${m.real_model}`} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <span className="font-mono text-sm font-medium text-[var(--color-foreground)]">{m.alias}</span>
                  {m.alias !== m.real_model ? (
                    <span className="ml-2 text-xs text-[var(--color-foreground-muted)]">({m.real_model})</span>
                  ) : null}
                </div>
                {m.period_label ? (
                  <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-foreground-muted)]">
                    {m.period_label}
                  </span>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {m.quota_requests !== null ? (
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--color-foreground-muted)]">请求配额</p>
                    <QuotaBar used={m.used_requests} total={m.quota_requests} />
                  </div>
                ) : null}
                {m.quota_tokens !== null ? (
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--color-foreground-muted)]">Token 配额</p>
                    <TokenBar used={m.used_tokens} total={m.quota_tokens} />
                  </div>
                ) : null}
                {m.period_quota_requests !== null ? (
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--color-foreground-muted)]">周期请求配额</p>
                    <QuotaBar used={m.period_used_requests ?? 0} total={m.period_quota_requests} />
                  </div>
                ) : null}
                {m.period_quota_tokens !== null ? (
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--color-foreground-muted)]">周期 Token 配额</p>
                    <TokenBar used={m.period_used_tokens ?? 0} total={m.period_quota_tokens} />
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
