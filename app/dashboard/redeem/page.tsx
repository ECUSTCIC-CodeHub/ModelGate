"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { authedFetch, getCachedProfile } from "@/lib/auth/client-auth";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { formatExpiresAt, formatNumber, formatTokenCount } from "@/lib/shared/utils";
import { modelGateFeatures } from "@/lib/core/features";
import type { PeriodQuotaEntry } from "@/lib/gateway/quota";

const periodQuotaEnabled = modelGateFeatures.periodQuota;

// 扫码与手输共用的唯一归一化规则：去首尾空白 → 去内部空白 → 大写 → 12 位裸码补连字符。
export function normalizeRedeemCodeInput(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9]{12}$/.test(cleaned)
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8)}`
    : cleaned;
}

// 自动兑换完成后移除 ?code=，刷新页面不会重复核销。
function clearRedeemQueryParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("code")) return;
  url.searchParams.delete("code");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

type Balance = {
  id: number;
  code_id: number;
  token_quota: number | null;
  request_quota: number | null;
  used_tokens: number;
  used_requests: number;
  allowed_channel_ids: number[];
  allowed_model_aliases: string[];
  expires_at: string | null;
  remaining_tokens: number | null;
  remaining_requests: number | null;
  periods?: PeriodQuotaEntry[];
  active: boolean;
  inactive_reason: string | null;
};

type Redemption = { id: number; code: string; redeemed_at: string };

export default function RedeemPage() {
  const searchParams = useSearchParams();
  const autoRedeemRef = useRef(false);
  const initialProfile = useAuthProfile();
  const [role] = useState<"admin" | "user">(() => (initialProfile?.role as "admin" | "user" | undefined) ?? (getCachedProfile()?.role as "admin" | "user" | undefined) ?? "user");
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authedFetch("/api/user/redeem");
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data) return;
    setBalances((data.data ?? []).map((b: Record<string, unknown>) => ({
      ...b,
      allowed_channel_ids: Array.isArray(b.allowed_channel_ids) ? b.allowed_channel_ids : [],
      allowed_model_aliases: Array.isArray(b.allowed_model_aliases) ? b.allowed_model_aliases : [],
    })));
    setRedemptions(data.redemptions ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const redeem = useCallback(async (rawCode: string, options?: { clearQuery?: boolean }) => {
    const normalized = normalizeRedeemCodeInput(rawCode);
    if (!normalized) return;
    setRedeeming(true);
    setSuccessMessage(null);
    try {
      const res = await authedFetch("/api/user/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: normalized }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error?.message ?? "兑换失败");
        return;
      }
      // 重置券不发放额度，响应体里没有额度对象，只有重置回执。
      const isReset = data?.data?.kind === "reset";
      const message = data?.message ?? (isReset ? "周期用量已重置。" : "兑换成功");
      toast.success(message);
      setSuccessMessage(message);
      setCode("");
      if (isReset) return;
      await load();
    } finally {
      setRedeeming(false);
      if (options?.clearQuery) clearRedeemQueryParam();
    }
  }, [load]);

  // 扫码直达：?code= 预填并自动兑换一次；完成后清掉参数，刷新不重兑。
  useEffect(() => {
    const deepLinkCode = searchParams.get("code");
    if (!deepLinkCode || autoRedeemRef.current) return;
    autoRedeemRef.current = true;
    void (async () => {
      // 先让出同步阶段再写 state，避免 effect 内的同步 setState 触发级联渲染告警。
      await Promise.resolve();
      const normalized = normalizeRedeemCodeInput(deepLinkCode);
      setCode(normalized);
      if (!normalized) {
        clearRedeemQueryParam();
        return;
      }
      await redeem(normalized, { clearQuery: true });
    })();
  }, [redeem, searchParams]);

  return (
    <DashboardShell role={role} title="兑换码" subtitle="输入兑换码获取定向额度或重置周期用量，额度可限定渠道与模型使用。">
      <div className="space-y-4 pb-6">
        <Card>
          <CardHeader>
            <SectionTitle title="兑换" description="输入管理员发放的兑换码：额度券用于获取限定渠道与模型的定向额度，重置券用于把周期用量清零。" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label>兑换码</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX"
                  className="font-mono uppercase"
                  onKeyDown={(e) => { if (e.key === "Enter") void redeem(code); }}
                />
              </div>
              <Button onClick={() => void redeem(code)} disabled={redeeming || !code.trim()}>
                {redeeming ? "兑换中…" : "兑换"}
              </Button>
            </div>
            {successMessage ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm">
                <span>{successMessage}</span>
                <Link
                  href="/dashboard/keys"
                  className="text-[var(--color-accent)] underline-offset-4 transition-colors hover:text-[var(--color-accent-hover)] hover:underline"
                >
                  去创建 API Key
                </Link>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {balances.length === 0 ? (
          <p className="text-sm text-[var(--color-foreground-muted)]">
            还没有定向额度。拿到管理员发放的兑换码后，在上方输入即可解锁对应渠道与模型。
          </p>
        ) : null}

        {balances.length > 0 ? (
          <Card>
            <CardHeader>
              <SectionTitle title="我的定向额度" description="以下额度仅在命中限定的渠道与模型时才会被扣减，不占用账户全局配额。" />
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>剩余 Token</TableHead>
                      <TableHead>剩余请求</TableHead>
                      {periodQuotaEnabled ? <TableHead>周期额度</TableHead> : null}
                      <TableHead>限定渠道</TableHead>
                      <TableHead>限定模型</TableHead>
                      <TableHead>有效期</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {balances.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell>
                          {b.token_quota != null
                            ? `${formatTokenCount(b.remaining_tokens ?? 0)} / ${formatTokenCount(b.token_quota)}`
                            : "不限"}
                        </TableCell>
                        <TableCell>
                          {b.request_quota != null
                            ? `${formatNumber(b.remaining_requests ?? 0)} / ${formatNumber(b.request_quota)}`
                            : "不限"}
                        </TableCell>
                        {periodQuotaEnabled ? (
                          <TableCell className="whitespace-nowrap text-xs">
                            {!b.periods || b.periods.length === 0 ? (
                              "—"
                            ) : (
                              b.periods.map((entry) => (
                                <div key={entry.id}>
                                  {entry.period_label}：
                                  {entry.quota_tokens === null ? "Token 不限" : `Token ${formatTokenCount(entry.remaining_tokens ?? 0)} / ${formatTokenCount(entry.quota_tokens)}`}
                                  {" · "}
                                  {entry.quota_requests === null ? "请求不限" : `请求 ${formatNumber(entry.remaining_requests ?? 0)} / ${formatNumber(entry.quota_requests)}`}
                                </div>
                              ))
                            )}
                          </TableCell>
                        ) : null}
                        <TableCell>{b.allowed_channel_ids.length === 0 ? "不限" : b.allowed_channel_ids.join(",")}</TableCell>
                        <TableCell>{b.allowed_model_aliases.length === 0 ? "不限" : b.allowed_model_aliases.join(",")}</TableCell>
                        <TableCell>{formatExpiresAt(b.expires_at)}</TableCell>
                        <TableCell>
                          <Badge variant={b.active ? "default" : "outline"}>{b.active ? "有效" : b.inactive_reason ?? "已用尽/过期"}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {redemptions.length > 0 ? (
          <Card>
            <CardHeader>
              <SectionTitle title="兑换记录" />
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>兑换码</TableHead>
                      <TableHead>兑换时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {redemptions.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-sm">{r.code}</TableCell>
                        <TableCell>{new Date(r.redeemed_at).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </DashboardShell>
  );
}
