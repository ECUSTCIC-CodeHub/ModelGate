"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import type { PeriodQuotaEntry } from "@/lib/gateway/quota";
import { quotaProgress } from "./dashboard-formatters";
import type { QuotaData } from "./dashboard-model";

type DashboardQuotaCardProps = {
  quota: QuotaData | null;
};

function formatRate(value: number, formatter: (value: number | null | undefined) => string) {
  return value < 0 ? "∞" : formatter(value);
}

function QuotaProgress({ remaining, quota }: { remaining: number | null; quota: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
      <div
        className="h-full rounded-full bg-[var(--color-accent)] transition-all"
        style={{ width: `${quotaProgress(remaining, quota)}%` }}
      />
    </div>
  );
}

// 单档周期配额块。多档与旧单档共用同一布局，避免两种渲染风格不一致。
function PeriodQuotaBlock({
  label,
  usedRequests,
  quotaRequests,
  remainingRequests,
  usedTokens,
  quotaTokens,
  remainingTokens,
  resetAt,
}: {
  label: string;
  usedRequests: number;
  quotaRequests: number | null;
  remainingRequests: number | null;
  usedTokens: number;
  quotaTokens: number | null;
  remainingTokens: number | null;
  resetAt: string | null;
}) {
  const showRequests = quotaRequests !== null;
  const showTokens = quotaTokens !== null;

  return (
    <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--color-foreground-muted)]">周期配额</p>
        <Badge variant="outline" className="text-xs">{label}</Badge>
      </div>
      {showRequests ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[var(--color-foreground)]">
            {formatNumber(remainingRequests)} <span className="text-xs font-normal text-[var(--color-foreground-muted)]">剩余请求</span>
          </p>
          <QuotaProgress remaining={remainingRequests} quota={quotaRequests} />
          <p className="text-xs text-[var(--color-foreground-muted)]">{formatNumber(usedRequests)} / {formatNumber(quotaRequests)} 已使用</p>
        </div>
      ) : null}
      {showTokens ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[var(--color-foreground)]">
            {formatTokenCount(remainingTokens)} <span className="text-xs font-normal text-[var(--color-foreground-muted)]">剩余 Token</span>
          </p>
          <QuotaProgress remaining={remainingTokens} quota={quotaTokens} />
          <p className="text-xs text-[var(--color-foreground-muted)]">{formatTokenCount(usedTokens)} / {formatTokenCount(quotaTokens)} 已使用</p>
        </div>
      ) : null}
      {!showRequests && !showTokens ? (
        <p className="text-xs text-[var(--color-foreground-muted)]">不限制</p>
      ) : null}
      {resetAt ? (
        <p className="text-xs text-[var(--color-foreground-muted)]">重置于 {new Date(resetAt).toLocaleString()}</p>
      ) : null}
    </div>
  );
}

export function DashboardQuotaCard({ quota }: DashboardQuotaCardProps) {
  if (!quota) return null;
  const periods: PeriodQuotaEntry[] = quota.periods ?? [];

  const showRate = quota.rate.rpm >= 0 || quota.rate.qps >= 0 || quota.rate.tpm >= 0;
  const showTotalRequests = quota.total.quota_requests !== null;
  const showTotalTokens = quota.total.quota_tokens !== null;

  if (!showRate && !showTotalRequests && !showTotalTokens && periods.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <SectionTitle title="我的配额与限制" description="查看当前账户的速率限制、配额使用情况。" />
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {showRate ? (
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-xs text-[var(--color-foreground-muted)]">速率限制</p>
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--color-foreground-muted)]">RPM</span>
                  <span className="font-mono text-[var(--color-foreground)]">{formatRate(quota.rate.rpm, formatNumber)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--color-foreground-muted)]">QPS</span>
                  <span className="font-mono text-[var(--color-foreground)]">{formatRate(quota.rate.qps, formatNumber)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--color-foreground-muted)]">TPM</span>
                  <span className="font-mono text-[var(--color-foreground)]">{formatRate(quota.rate.tpm, formatTokenCount)}</span>
                </div>
              </div>
            </div>
          ) : null}

          {showTotalRequests ? (
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-xs text-[var(--color-foreground-muted)]">总请求配额</p>
              <p className="text-lg font-semibold text-[var(--color-foreground)]">
                {formatNumber(quota.total.remaining_requests)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
              </p>
              <QuotaProgress remaining={quota.total.remaining_requests} quota={quota.total.quota_requests} />
              <p className="text-xs text-[var(--color-foreground-muted)]">{formatNumber(quota.total.used_requests)} / {formatNumber(quota.total.quota_requests)} 已使用</p>
            </div>
          ) : null}

          {showTotalTokens ? (
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-xs text-[var(--color-foreground-muted)]">总 Token 配额</p>
              <p className="text-lg font-semibold text-[var(--color-foreground)]">
                {formatTokenCount(quota.total.remaining_tokens)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
              </p>
              <QuotaProgress remaining={quota.total.remaining_tokens} quota={quota.total.quota_tokens} />
              <p className="text-xs text-[var(--color-foreground-muted)]">{formatTokenCount(quota.total.used_tokens)} / {formatTokenCount(quota.total.quota_tokens)} 已使用</p>
            </div>
          ) : null}

          {periods.length > 0
            ? periods.map((entry) => (
                <PeriodQuotaBlock
                  key={entry.id}
                  label={entry.period_label}
                  usedRequests={entry.used_requests}
                  quotaRequests={entry.quota_requests}
                  remainingRequests={entry.remaining_requests}
                  usedTokens={entry.used_tokens}
                  quotaTokens={entry.quota_tokens}
                  remainingTokens={entry.remaining_tokens}
                  resetAt={entry.reset_at}
                />
              ))
            : null}
        </div>
      </CardContent>
    </Card>
  );
}
