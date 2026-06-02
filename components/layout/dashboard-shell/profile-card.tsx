"use client";

import { modelGateFeatures } from "@/lib/core/features";
import { formatLimit, periodExpired, periodLabel } from "@/components/layout/dashboard-shell/format";
import { ProfileActions } from "@/components/layout/dashboard-shell/profile-actions";
import type { ProfileBrief } from "@/components/layout/dashboard-shell/types";

type ProfileCardProps = {
  profile: ProfileBrief;
  oidcAvailable: boolean;
  passwordLoginEnabled: boolean;
  onChangePassword: () => void;
  onOidcBind: () => void;
  onOidcSync: () => void;
  onOidcUnbind: () => void;
  onTotpManage: () => void;
  onLogout: () => void;
};

type QuotaRow = readonly [string, number, number];

function quotaRows(profile: ProfileBrief) {
  const rows: Array<QuotaRow | null> = [
    profile.quota_requests !== null && profile.quota_requests !== undefined
      ? ["总请求", profile.used_requests ?? 0, profile.quota_requests]
      : null,
    profile.quota_tokens !== null && profile.quota_tokens !== undefined
      ? ["总Token", profile.used_tokens ?? 0, profile.quota_tokens]
      : null,
    modelGateFeatures.periodQuota && profile.quota_period && profile.period_quota_requests !== null && profile.period_quota_requests !== undefined
      ? [`${periodLabel(profile.quota_period)}请求`, periodExpired(profile.period_reset_at) ? 0 : (profile.period_used_requests ?? 0), profile.period_quota_requests]
      : null,
    modelGateFeatures.periodQuota && profile.quota_period && profile.period_quota_tokens !== null && profile.period_quota_tokens !== undefined
      ? [`${periodLabel(profile.quota_period)}Token`, periodExpired(profile.period_reset_at) ? 0 : (profile.period_used_tokens ?? 0), profile.period_quota_tokens]
      : null,
  ];
  return rows.filter((item): item is QuotaRow => Boolean(item));
}

export function DesktopProfileCard({
  profile,
  oidcAvailable,
  passwordLoginEnabled,
  onChangePassword,
  onOidcBind,
  onOidcSync,
  onOidcUnbind,
  onTotpManage,
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
        {quotaRows(profile).map(([label, used, total]) => {
          const remaining = Math.max(0, total - used);
          return (
            <div key={label} className="mt-0.5">
              <span className="text-[10px] tracking-wide text-[var(--color-foreground-muted)]">{label}</span>
              <div className="flex justify-end font-mono text-sm text-[var(--color-foreground)]">
                <span>{formatLimit(remaining)}</span>
                <span className="text-[var(--color-foreground-muted)]"> / {formatLimit(total)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <ProfileActions
        oidcAvailable={oidcAvailable}
        oidcBound={Boolean(profile.oidc_subject)}
        passwordLoginEnabled={passwordLoginEnabled}
        totpEnabled={profile.totp_enabled === 1}
        onChangePassword={onChangePassword}
        onOidcBind={onOidcBind}
        onOidcSync={onOidcSync}
        onOidcUnbind={onOidcUnbind}
        onTotpManage={onTotpManage}
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
          配额: 请求 {formatLimit(profile.used_requests ?? 0)}/{formatLimit(profile.quota_requests)} / Token {formatLimit(profile.used_tokens ?? 0)}/{formatLimit(profile.quota_tokens)}
        </p>
      ) : null}
      {modelGateFeatures.periodQuota && profile.quota_period ? (
        <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
          {periodLabel(profile.quota_period)}: 请求 {formatLimit(periodExpired(profile.period_reset_at) ? 0 : (profile.period_used_requests ?? 0))}/{formatLimit(profile.period_quota_requests)} / Token {formatLimit(periodExpired(profile.period_reset_at) ? 0 : (profile.period_used_tokens ?? 0))}/{formatLimit(profile.period_quota_tokens)}
        </p>
      ) : null}
    </div>
  );
}
