"use client";

import { modelGateFeatures } from "@/lib/core/features";
import { formatLimit, formatResetIn, isUnlimited, usageRatio } from "@/components/layout/dashboard-shell/format";
import { ProfileActions } from "@/components/layout/dashboard-shell/profile-actions";
import type { ProfileBrief } from "@/components/layout/dashboard-shell/types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber, formatTokenCount, cn } from "@/lib/shared/utils";

type ProfileCardProps = {
  profile: ProfileBrief;
  oidcAvailable: boolean;
  passwordLoginEnabled: boolean;
  onChangePassword: () => void;
  onOidcBind: () => void;
  onOidcSync: () => void;
  onOidcUnbind: () => void;
  onLogout: () => void;
};

type QuotaBar = { key: string; label: string; ratio: number; title: string };

// 请求用带千分位的整数、Token 用紧凑单位，与「配额与限制」页一致。
// 不能两处都用 formatLimit：4,978 与 5,000 都会被压成 5.0k，
// 显示成「5.0k / 5.0k」会被误读成额度已耗尽。
function requestPair(remaining: number, total: number): string {
  return `${formatNumber(remaining)} / ${formatNumber(total)}`;
}

function tokenPair(remaining: number, total: number): string {
  return `${formatTokenCount(remaining)} / ${formatTokenCount(total)}`;
}

// 一个周期档一行，请求与 Token 合并到同一行。
// 两个维度都带上「请求」/「Token」前缀：只设一个维度时不加前缀会分不清那一串数字
// 是请求数还是 Token 数。
function cycleValue(requests: string | null, tokens: string | null): string {
  const parts: string[] = [];
  if (requests !== null) parts.push(`请求 ${requests}`);
  if (tokens !== null) parts.push(`Token ${tokens}`);
  return parts.join(" · ");
}

type BarInput = {
  key: string;
  label: string;
  requests: { used: number; total: number | null; remaining: number | null };
  tokens: { used: number; total: number | null; remaining: number | null };
  resetAt: string | null;
};

// 侧边栏只放进度条，精确数字与重置时间放悬浮提示：
// 常驻渲染全部档位的数字会把资料卡撑得很高，而这里只需要一眼看出「哪个档快满了」。
// 进度条取请求与 Token 中占用更高的一维，任一维超限都意味着被卡住。
// 未设限（null 或 -1）的维度不参与，因此全都不限的档位不会占位。
function toBar(input: BarInput): QuotaBar | null {
  const ratios = [input.requests, input.tokens]
    .filter((dim) => !isUnlimited(dim.total))
    .map((dim) => usageRatio(dim.used, dim.total) ?? 0);
  if (ratios.length === 0) return null;

  const parts: string[] = [];
  if (!isUnlimited(input.requests.total)) {
    parts.push(`请求 ${requestPair(input.requests.remaining ?? 0, input.requests.total)}`);
  }
  if (!isUnlimited(input.tokens.total)) {
    parts.push(`Token ${tokenPair(input.tokens.remaining ?? 0, input.tokens.total)}`);
  }
  const reset = formatResetIn(input.resetAt);
  if (reset) parts.push(reset);

  return {
    key: input.key,
    label: input.label,
    ratio: Math.max(...ratios),
    title: `${input.label}: ${parts.join(" · ")}`,
  };
}

// 进度条宽度：未耗尽时封顶 99%，避免 99.5% 四舍五入成满格、
// 让「还没超限」看起来和「已经超限」一样；真正耗尽才给 100%。
// 下界保底 1%：极小但非零的占用不该被抹成 0%，与「完全没用到」区分开
// （1% 在 4px 条上肉眼几乎看不出，这里只是不把刻度归零）。
function barWidth(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio >= 1) return 100;
  return Math.max(1, Math.min(99, Math.round(ratio * 100)));
}

function quotaBars(profile: ProfileBrief): QuotaBar[] {
  const bars: QuotaBar[] = [];
  // ProfileBrief 只给总量配额与已用量，剩余在这里算；周期档则由服务端直接给出剩余。
  const usedRequests = profile.used_requests ?? 0;
  const usedTokens = profile.used_tokens ?? 0;
  const totalBar = toBar({
    key: "total",
    label: "总量",
    requests: {
      used: usedRequests,
      total: profile.quota_requests,
      remaining: isUnlimited(profile.quota_requests) ? null : Math.max(0, profile.quota_requests - usedRequests),
    },
    tokens: {
      used: usedTokens,
      total: profile.quota_tokens,
      remaining: isUnlimited(profile.quota_tokens) ? null : Math.max(0, profile.quota_tokens - usedTokens),
    },
    resetAt: null,
  });
  if (totalBar) bars.push(totalBar);
  if (!modelGateFeatures.periodQuota) return bars;

  const periods = profile.periods;
  if (periods === undefined) return bars;
  for (const entry of periods) {
    // key 用秒数：自有档与继承档的 id 都由序号生成，可能重名；秒数在同一用户内唯一。
    const bar = toBar({
      key: String(entry.period_seconds),
      label: entry.period_label,
      requests: { used: entry.used_requests, total: entry.quota_requests, remaining: entry.remaining_requests },
      tokens: { used: entry.used_tokens, total: entry.quota_tokens, remaining: entry.remaining_tokens },
      resetAt: entry.reset_at,
    });
    if (bar) bars.push(bar);
  }
  return bars;
}

export function DesktopProfileCard({
  profile,
  oidcAvailable,
  passwordLoginEnabled,
  onChangePassword,
  onOidcBind,
  onOidcSync,
  onOidcUnbind,
  onLogout,
}: ProfileCardProps) {
  // 未设限的速率不占位：全是 ∞ 的行没有信息量，只会把资料卡撑高。
  const rateRows = ([
    ["RPM", profile.rpm],
    ["QPS", profile.qps],
    ["TPM", profile.tpm],
  ] as const).filter(([, value]) => !isUnlimited(value));
  const bars = quotaBars(profile);

  return (
    <TooltipProvider>
      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{profile.username}</p>
        </div>
        {rateRows.length > 0 || bars.length > 0 ? (
          <div className="space-y-1.5 rounded-md bg-[var(--color-bg)]/55 px-3 py-2 tabular-nums">
            {rateRows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-foreground-muted)]">{label}</span>
                <span className="font-mono text-sm text-[var(--color-foreground)]">{formatLimit(value)}</span>
              </div>
            ))}
            {bars.map(({ key, label, ratio, title }) => (
              // 用 Tooltip 而不是 title 属性：title 无法键盘聚焦、触屏也不可达，
              // 而这里的数字是唯一能看出「还剩多少」的地方。
              // 触发元素补 tabIndex 使其可聚焦，aria-label 让屏幕阅读器聚焦时直接读出用量，
              // 不必依赖 tooltip 打开。注意 asChild 要求恰好一个子元素，注释不要写在 Trigger 内部。
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <div
                    className="pt-1 first:pt-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                    tabIndex={0}
                    aria-label={title}
                  >
                    <span className="text-[10px] tracking-wide text-[var(--color-foreground-muted)]">{label}</span>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
                      <div
                        className={cn(
                          "h-full rounded-full transition-[width] duration-300",
                          // 只有真正耗尽才用告警色，其余用主题强调色：库内没有 warning 色变量，
                          // 不为此新增（需同时补 4 套主题），也避免把「用了 80%」渲染成错误。
                          ratio >= 1 ? "bg-[var(--color-destructive)]" : "bg-[var(--color-accent)]",
                        )}
                        style={{ width: `${barWidth(ratio)}%` }}
                      />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{title}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ) : null}
        <ProfileActions
          oidcAvailable={oidcAvailable}
          oidcBound={Boolean(profile.oidc_subject)}
          passwordLoginEnabled={passwordLoginEnabled}
          onChangePassword={onChangePassword}
          onOidcBind={onOidcBind}
          onOidcSync={onOidcSync}
          onOidcUnbind={onOidcUnbind}
          onLogout={onLogout}
        />
      </div>
    </TooltipProvider>
  );
}

export function MobileProfileSummary({ profile }: { profile: ProfileBrief }) {
  const rateRows = ([
    ["RPM", profile.rpm],
    ["QPS", profile.qps],
    ["TPM", profile.tpm],
  ] as const).filter(([, value]) => !isUnlimited(value));

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{profile.username}</p>
      {rateRows.length > 0 ? (
        <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
          {rateRows.map(([label, value]) => `${label} ${formatLimit(value)}`).join(" / ")}
        </p>
      ) : null}
      {profile.quota_requests !== null || profile.quota_tokens !== null ? (
        <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
          配额:
          {!isUnlimited(profile.quota_requests)
            ? ` 请求 ${formatNumber(Math.max(0, profile.quota_requests - (profile.used_requests ?? 0)))}/${formatNumber(profile.quota_requests)}`
            : ""}
          {!isUnlimited(profile.quota_tokens)
            ? ` Token ${formatTokenCount(Math.max(0, profile.quota_tokens - (profile.used_tokens ?? 0)))}/${formatTokenCount(profile.quota_tokens)}`
            : ""}
        </p>
      ) : null}
      {modelGateFeatures.periodQuota && profile.periods
        ? profile.periods
          .filter((entry) => !isUnlimited(entry.quota_requests) || !isUnlimited(entry.quota_tokens))
          .map((entry) => (
          <p key={entry.period_seconds} className="mt-1 text-xs text-[var(--color-foreground-muted)]">
            {entry.period_label}{" "}
            {cycleValue(
              !isUnlimited(entry.quota_requests) ? requestPair(entry.remaining_requests ?? 0, entry.quota_requests) : null,
              !isUnlimited(entry.quota_tokens) ? tokenPair(entry.remaining_tokens ?? 0, entry.quota_tokens) : null,
            )}
            {formatResetIn(entry.reset_at) ? ` · ${formatResetIn(entry.reset_at)}` : ""}
          </p>
          ))
        : null}
    </div>
  );
}
