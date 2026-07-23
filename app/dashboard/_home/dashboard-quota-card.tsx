"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
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

export function DashboardQuotaCard({ quota }: DashboardQuotaCardProps) {
  if (!quota) return null;
  const period = quota.period;

  const showRate = quota.rate.rpm >= 0 || quota.rate.qps >= 0 || quota.rate.tpm >= 0;
  const showTotalRequests = quota.total.quota_requests !== null;
  const showTotalTokens = quota.total.quota_tokens !== null;
  const showPeriodRequests = !!period && period.quota_requests !== null;
  const showPeriodTokens = !!period && period.quota_tokens !== null;

  if (!showRate && !showTotalRequests && !showTotalTokens && !showPeriodRequests && !showPeriodTokens) {
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

          {showPeriodRequests ? (
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-xs text-[var(--color-foreground-muted)]">{period!.period_label}请求配额</p>
              <p className="text-lg font-semibold text-[var(--color-foreground)]">
                {formatNumber(period!.remaining_requests)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
              </p>
              <QuotaProgress remaining={period!.remaining_requests} quota={period!.quota_requests} />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                {formatNumber(period!.used_requests)} / {formatNumber(period!.quota_requests)} 已使用
                {period!.reset_at ? ` · 重置于 ${new Date(period!.reset_at).toLocaleString()}` : ""}
              </p>
            </div>
          ) : null}

          {showPeriodTokens ? (
            <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
              <p className="text-xs text-[var(--color-foreground-muted)]">{period!.period_label} Token 配额</p>
              <p className="text-lg font-semibold text-[var(--color-foreground)]">
                {formatTokenCount(period!.remaining_tokens)} <span className="text-sm font-normal text-[var(--color-foreground-muted)]">剩余</span>
              </p>
              <QuotaProgress remaining={period!.remaining_tokens} quota={period!.quota_tokens} />
              <p className="text-xs text-[var(--color-foreground-muted)]">
                {formatTokenCount(period!.used_tokens)} / {formatTokenCount(period!.quota_tokens)} 已使用
                {period!.reset_at ? ` · 重置于 ${new Date(period!.reset_at).toLocaleString()}` : ""}
              </p>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
