"use client";

import { modelGateFeatures } from "@/lib/core/features";
import { formatLimit, formatResetIn, isUnlimited } from "@/components/layout/dashboard-shell/format";
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

type QuotaBar = { key: string; label: string; remaining: number; blocked: boolean; title: string };

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

// 每个档位只画一条条，取当前最紧张的那一维（剩余比例最低者）。
// 请求与 Token 是两个独立制约（判定是任一维触顶即拒），但侧边栏高度有限，
// 两维各占一行会让四个档位撑成八行；只显示最紧张的一维，
// 既回答「这个档会不会卡住我」，也让另一维的精确值留在悬浮提示里。
//
// 口径与首页「我的配额与限制」一致：条越满表示剩余越多（remaining / total），
// 与 app/dashboard/quota 页的 used/total 相反，两者在库内并存；这里跟随首页。
type Dimension = { request: boolean; total: number; remaining: number };

function dimensions(input: BarInput): Dimension[] {
  const dims: Dimension[] = [];
  if (!isUnlimited(input.requests.total)) {
    const total = input.requests.total;
    dims.push({
      request: true,
      total,
      remaining: input.requests.remaining ?? Math.max(0, total - input.requests.used),
    });
  }
  if (!isUnlimited(input.tokens.total)) {
    const total = input.tokens.total;
    dims.push({
      request: false,
      total,
      remaining: input.tokens.remaining ?? Math.max(0, total - input.tokens.used),
    });
  }
  return dims;
}

function toBar(input: BarInput): QuotaBar | null {
  const dims = dimensions(input);
  if (dims.length === 0) return null;

  // 剩余比例最低者为最紧张的一维；并列时取请求（更常见的瓶颈）。
  const tightest = dims.reduce((worst, dim) => (remainingRatio(dim) < remainingRatio(worst) ? dim : worst));

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
    // 只显示最紧张的一维，标签要带上维度名，否则看不出这条是请求还是 Token。
    label: `${input.label} · ${tightest.request ? "请求" : "Token"}`,
    remaining: remainingRatio(tightest),
    blocked: tightest.remaining <= 0,
    title: `${input.label}: ${parts.join(" · ")}`,
  };
}

// 剩余比例，与首页 quotaProgress 同口径。仅在已判定该维已设限后调用。
function remainingRatio(dim: Dimension): number {
  if (dim.total <= 0) return 0;
  return Math.max(0, Math.min(1, dim.remaining / dim.total));
}

// 剩余条宽度：条越满代表剩得越多。剩余为 0 时给 0%（条空 = 已被卡住），
// 但非零剩余保底 1%，避免「只剩一点点」被抹成「一点不剩」。
function barWidth(remaining: number): number {
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.max(1, Math.min(100, Math.round(remaining * 100)));
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
            {bars.map(({ key, label, remaining, blocked, title }) => (
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
                          // 条是「剩余量」，所以空条才是告警：只有剩余归零才用 destructive 色。
                          // 其余用强调色；库内没有 warning 色变量，不为此新增 4 套主题。
                          blocked ? "bg-[var(--color-destructive)]" : "bg-[var(--color-accent)]",
                        )}
                        style={{ width: `${barWidth(remaining)}%` }}
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
