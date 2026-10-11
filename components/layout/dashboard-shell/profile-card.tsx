"use client";

import { modelGateFeatures } from "@/lib/core/features";
import { formatLimit } from "@/components/layout/dashboard-shell/format";
import { ProfileActions } from "@/components/layout/dashboard-shell/profile-actions";
import type { ProfileBrief } from "@/components/layout/dashboard-shell/types";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";

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

type QuotaRow = { key: string; label: string; value: string };

// 请求用带千分位的整数、Token 用紧凑单位，与「配额与限制」页一致。
// 不能两处都用 formatLimit：4,978 与 5,000 都会被压成 5.0k，
// 显示成「5.0k / 5.0k」会被误读成额度已耗尽。
function requestPair(remaining: number, total: number): string {
  return `${formatNumber(remaining)} / ${formatNumber(total)}`;
}

function tokenPair(remaining: number, total: number): string {
  return `${formatTokenCount(remaining)} / ${formatTokenCount(total)}`;
}

// 一个周期档占一行，请求与 Token 合并到同一行。
// 两个维度都带上「请求」/「Token」前缀：只设一个维度时不加前缀会分不清那一串数字
// 是请求数还是 Token 数。
function cycleValue(requests: string | null, tokens: string | null): string {
  const parts: string[] = [];
  if (requests !== null) parts.push(`请求 ${requests}`);
  if (tokens !== null) parts.push(`Token ${tokens}`);
  return parts.join(" · ");
}

function quotaRows(profile: ProfileBrief): QuotaRow[] {
  const rows: QuotaRow[] = [];
  if (profile.quota_requests !== null && profile.quota_requests !== undefined) {
    rows.push({
      key: "total-requests",
      label: "总请求",
      value: requestPair(Math.max(0, profile.quota_requests - (profile.used_requests ?? 0)), profile.quota_requests),
    });
  }
  if (profile.quota_tokens !== null && profile.quota_tokens !== undefined) {
    rows.push({
      key: "total-tokens",
      label: "总Token",
      value: tokenPair(Math.max(0, profile.quota_tokens - (profile.used_tokens ?? 0)), profile.quota_tokens),
    });
  }
  if (!modelGateFeatures.periodQuota) return rows;

  // 多档周期优先：服务端已按档懒重置并算好剩余，直接用它的值，
  // 与「配额与限制」页保持同一口径。
  // periods 为 undefined 表示首帧（SSR）尚未拿到数据，此时不展示旧单档值，
  // 否则会先闪出一份与真实多档配置不符的过期额度再跳变。
  const periods = profile.periods;
  if (periods === undefined) return rows;
  if (periods.length > 0) {
    for (const entry of periods) {
      const requests = entry.quota_requests;
      const tokens = entry.quota_tokens;
      // 两个维度都不限额的档位是脏数据，不渲染，避免出现只有周期的空行。
      if (requests === null && tokens === null) continue;
      // key 用秒数：自有档与继承档的 id 都由序号生成，可能重名；秒数在同一用户内唯一。
      rows.push({
        key: String(entry.period_seconds),
        label: entry.period_label,
        value: cycleValue(
          requests !== null ? requestPair(entry.remaining_requests ?? 0, requests) : null,
          tokens !== null ? tokenPair(entry.remaining_tokens ?? 0, tokens) : null,
        ),
      });
    }
    return rows;
  }

  // periods 为空数组表示确实没有配置任何周期档，此时不再回退旧单档列
  // （旧列已停止写入，回退只会展示过期额度）。
  return rows;
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
  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{profile.username}</p>
      </div>
      <div className="space-y-1.5 rounded-md bg-[var(--color-bg)]/55 px-3 py-2 tabular-nums">
        {([
          ["RPM", formatLimit(profile.rpm)],
          ["QPS", formatLimit(profile.qps)],
          ["TPM", formatLimit(profile.tpm)],
        ] as const).map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-foreground-muted)]">{label}</span>
            <span className="font-mono text-sm text-[var(--color-foreground)]">{value}</span>
          </div>
        ))}
        {quotaRows(profile).map(({ key, label, value }) => (
          <div key={key} className="mt-0.5">
            <span className="text-[10px] tracking-wide text-[var(--color-foreground-muted)]">{label}</span>
            <div className="flex justify-end font-mono text-sm text-[var(--color-foreground)]">
              <span>{value}</span>
            </div>
          </div>
        ))}
      </div>
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
  );
}

export function MobileProfileSummary({ profile }: { profile: ProfileBrief }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] p-4">
      <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{profile.username}</p>
      <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
        RPM {formatLimit(profile.rpm)} / QPS {formatLimit(profile.qps)} / TPM {formatLimit(profile.tpm)}
      </p>
      {profile.quota_requests !== null || profile.quota_tokens !== null ? (
        <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
          配额:
          {profile.quota_requests !== null
            ? ` 请求 ${formatNumber(Math.max(0, profile.quota_requests - (profile.used_requests ?? 0)))}/${formatNumber(profile.quota_requests)}`
            : ""}
          {profile.quota_tokens !== null
            ? ` Token ${formatTokenCount(Math.max(0, profile.quota_tokens - (profile.used_tokens ?? 0)))}/${formatTokenCount(profile.quota_tokens)}`
            : ""}
        </p>
      ) : null}
      {modelGateFeatures.periodQuota && profile.periods && profile.periods.length > 0
        ? profile.periods
          .filter((entry) => entry.quota_requests !== null || entry.quota_tokens !== null)
          .map((entry) => (
          <p key={entry.period_seconds} className="mt-1 text-xs text-[var(--color-foreground-muted)]">
            {entry.period_label}{" "}
            {cycleValue(
              entry.quota_requests !== null ? requestPair(entry.remaining_requests ?? 0, entry.quota_requests) : null,
              entry.quota_tokens !== null ? tokenPair(entry.remaining_tokens ?? 0, entry.quota_tokens) : null,
            )}
          </p>
          ))
        : null}
    </div>
  );
}
