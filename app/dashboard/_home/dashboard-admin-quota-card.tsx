"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import { quotaProgress } from "./dashboard-formatters";

export type AdminQuotaOverview = {
  total_users: number;
  total_keys: number;
  groups: Array<{
    id: number;
    name: string;
    user_count: number;
    quota_tokens: number | null;
    quota_requests: number | null;
    used_tokens: number;
    used_requests: number;
    remaining_tokens: number | null;
    remaining_requests: number | null;
    quota_period: number | null;
    period_label: string | null;
    period_quota_tokens: number | null;
    period_quota_requests: number | null;
    period_used_tokens: number | null;
    period_used_requests: number | null;
    period_remaining_tokens: number | null;
    period_remaining_requests: number | null;
  }>;
  models: Array<{
    id: number;
    alias: string;
    real_model: string;
    channel_name: string;
    quota_mode: string;
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
  }>;
};

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

export function DashboardAdminQuotaCard({ overview }: { overview: AdminQuotaOverview | null }) {
  return (
    <div className="space-y-4 pb-6">
      <Card>
        <CardHeader>
          <SectionTitle title="系统配额概览" description="全局视角查看各用户组和特殊模型的配额使用情况。" />
        </CardHeader>
        <CardContent>
          {overview ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <p className="text-xs text-[var(--color-foreground-muted)]">活跃用户</p>
                <p className="text-lg font-semibold text-[var(--color-foreground)]">{formatNumber(overview.total_users)}</p>
              </div>
              <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <p className="text-xs text-[var(--color-foreground-muted)]">API 密钥</p>
                <p className="text-lg font-semibold text-[var(--color-foreground)]">{formatNumber(overview.total_keys)}</p>
              </div>
              <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <p className="text-xs text-[var(--color-foreground-muted)]">用户组</p>
                <p className="text-lg font-semibold text-[var(--color-foreground)]">{formatNumber(overview.groups.length)}</p>
              </div>
              <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
                <p className="text-xs text-[var(--color-foreground-muted)]">特殊配额模型</p>
                <p className="text-lg font-semibold text-[var(--color-foreground)]">{formatNumber(overview.models.length)}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--color-foreground-muted)]">加载中...</p>
          )}
        </CardContent>
      </Card>

      {overview?.groups && overview.groups.length > 0 ? (
        <Card>
          <CardHeader>
            <SectionTitle title="用户组配额" description="各用户组的配额配置与使用情况汇总。" />
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <Table className="min-w-[800px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>用户组</TableHead>
                    <TableHead>用户数</TableHead>
                    <TableHead>Token 配额</TableHead>
                    <TableHead>请求配额</TableHead>
                    {overview.groups.some((g) => g.period_label) ? <TableHead>周期配额</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.groups.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-medium">{g.name}</TableCell>
                      <TableCell>{formatNumber(g.user_count)}</TableCell>
                      <TableCell>
                        {g.quota_tokens !== null ? (
                          <div className="space-y-1">
                            <QuotaProgress remaining={g.remaining_tokens} quota={g.quota_tokens} />
                            <p className="text-xs text-[var(--color-foreground-muted)]">
                              {formatTokenCount(g.used_tokens)} / {formatTokenCount(g.quota_tokens)}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {g.quota_requests !== null ? (
                          <div className="space-y-1">
                            <QuotaProgress remaining={g.remaining_requests} quota={g.quota_requests} />
                            <p className="text-xs text-[var(--color-foreground-muted)]">
                              {formatNumber(g.used_requests)} / {formatNumber(g.quota_requests)}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--color-foreground-muted)]">不限制</span>
                        )}
                      </TableCell>
                      {overview.groups.some((g) => g.period_label) ? (
                        <TableCell>
                          {g.period_label && (g.period_quota_tokens !== null || g.period_quota_requests !== null) ? (
                            <div className="space-y-1">
                              <Badge variant="outline" className="text-xs">{g.period_label}</Badge>
                              {g.period_quota_tokens !== null ? (
                                <p className="text-xs text-[var(--color-foreground-muted)]">
                                  Token: {formatTokenCount(g.period_used_tokens ?? 0)} / {formatTokenCount(g.period_quota_tokens)}
                                </p>
                              ) : null}
                              {g.period_quota_requests !== null ? (
                                <p className="text-xs text-[var(--color-foreground-muted)]">
                                  请求: {formatNumber(g.period_used_requests ?? 0)} / {formatNumber(g.period_quota_requests)}
                                </p>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--color-foreground-muted)]">-</span>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {overview?.models && overview.models.length > 0 ? (
        <Card>
          <CardHeader>
            <SectionTitle title="特殊配额模型" description="绕过用户组限制或使用独立配额的模型。" />
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <Table className="min-w-[800px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead>渠道</TableHead>
                    <TableHead>配额模式</TableHead>
                    <TableHead>Token 配额</TableHead>
                    <TableHead>请求配额</TableHead>
                    {overview.models.some((m) => m.period_label) ? <TableHead>周期配额</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.models.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div>
                          <span className="font-mono text-sm">{m.alias}</span>
                          {m.alias !== m.real_model ? (
                            <span className="ml-2 text-xs text-[var(--color-foreground-muted)]">({m.real_model})</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-[var(--color-foreground-muted)]">{m.channel_name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {m.quota_mode === "independent" ? "独立配额" : "绕过用户组"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {m.quota_mode === "independent" && m.quota_tokens !== null ? (
                          <div className="space-y-1">
                            <QuotaProgress remaining={m.remaining_tokens} quota={m.quota_tokens} />
                            <p className="text-xs text-[var(--color-foreground-muted)]">
                              {formatTokenCount(m.used_tokens ?? 0)} / {formatTokenCount(m.quota_tokens)}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--color-foreground-muted)]">
                            {m.quota_mode === "bypass_group" ? "不受限" : "不限制"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {m.quota_mode === "independent" && m.quota_requests !== null ? (
                          <div className="space-y-1">
                            <QuotaProgress remaining={m.remaining_requests} quota={m.quota_requests} />
                            <p className="text-xs text-[var(--color-foreground-muted)]">
                              {formatNumber(m.used_requests ?? 0)} / {formatNumber(m.quota_requests)}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--color-foreground-muted)]">
                            {m.quota_mode === "bypass_group" ? "不受限" : "不限制"}
                          </span>
                        )}
                      </TableCell>
                      {overview.models.some((m) => m.period_label) ? (
                        <TableCell>
                          {m.quota_mode === "independent" && m.period_label && (m.period_quota_tokens !== null || m.period_quota_requests !== null) ? (
                            <div className="space-y-1">
                              <Badge variant="outline" className="text-xs">{m.period_label}</Badge>
                              {m.period_quota_tokens !== null ? (
                                <p className="text-xs text-[var(--color-foreground-muted)]">
                                  Token: {formatTokenCount(m.period_used_tokens ?? 0)} / {formatTokenCount(m.period_quota_tokens)}
                                </p>
                              ) : null}
                              {m.period_quota_requests !== null ? (
                                <p className="text-xs text-[var(--color-foreground-muted)]">
                                  请求: {formatNumber(m.period_used_requests ?? 0)} / {formatNumber(m.period_quota_requests)}
                                </p>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--color-foreground-muted)]">-</span>
                          )}
                        </TableCell>
                      ) : null}
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
