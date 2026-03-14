/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SectionTitle } from "@/components/dashboard/section-title";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession, getOrFetchProfile } from "@/lib/client-auth";

export default function AdminSettingsPage() {
  const router = useRouter();
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [defaultQps, setDefaultQps] = useState(-1);
  const [defaultRpm, setDefaultRpm] = useState(-1);
  const [defaultTpm, setDefaultTpm] = useState(-1);
  const [defaultQuotaRequests, setDefaultQuotaRequests] = useState(-1);
  const [defaultQuotaTokens, setDefaultQuotaTokens] = useState(-1);
  const [upstreamRetryEnabled, setUpstreamRetryEnabled] = useState(true);
  const [upstreamRetryMaxAttempts, setUpstreamRetryMaxAttempts] = useState(3);
  const { toast } = useToast();

  async function ensureAdmin() {
    const profile = await getOrFetchProfile();
    if (!profile) {
      clearSession();
      router.push("/login");
      return false;
    }
    if (profile.role !== "admin") {
      router.push("/dashboard/keys");
      return false;
    }
    return true;
  }

  async function load() {
    if (!(await ensureAdmin())) return;
    const response = await authedFetch("/api/dashboard/settings");
    const data = await response.json();
    if (response.ok) {
      setRegistrationEnabled(data.data.registration_enabled === 1);
      setDefaultQps(Number(data.data.default_qps ?? -1));
      setDefaultRpm(Number(data.data.default_rpm ?? -1));
      setDefaultTpm(Number(data.data.default_tpm ?? -1));
      setDefaultQuotaRequests(Number(data.data.default_quota_requests ?? -1));
      setDefaultQuotaTokens(Number(data.data.default_quota_tokens ?? -1));
      setUpstreamRetryEnabled(data.data.upstream_retry_enabled !== 0);
      setUpstreamRetryMaxAttempts(Number(data.data.upstream_retry_max_attempts ?? 3));
    }
  }

  useEffect(() => {
    void load();
  }, [router]);

  async function save() {
    const response = await authedFetch("/api/dashboard/settings", {
      method: "PUT",
      body: JSON.stringify({
        registration_enabled: registrationEnabled,
        default_qps: defaultQps,
        default_rpm: defaultRpm,
        default_tpm: defaultTpm,
        default_quota_requests: defaultQuotaRequests,
        default_quota_tokens: defaultQuotaTokens,
        upstream_retry_enabled: upstreamRetryEnabled,
        upstream_retry_max_attempts: upstreamRetryMaxAttempts,
      }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "保存成功。") });
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "保存失败。") });
  }

  return (
    <DashboardShell role="admin" title="系统设置" subtitle="配置注册策略、默认配额和上游重试行为。">
      <div className="space-y-4 pb-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <Card>
            <CardHeader>
              <SectionTitle
                title="注册与默认限流"
                description="新用户默认继承这些限速和配额配置。"
              />
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-100">开启公开注册</p>
                  <p className="text-xs text-zinc-500">关闭后仅管理员可创建用户。</p>
                </div>
                <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <div className="space-y-2">
                  <Label>默认 QPS</Label>
                  <Input type="number" min={-1} value={defaultQps} onChange={(e) => setDefaultQps(Number(e.target.value))} />
                  <p className="text-xs text-zinc-500">-1 不限速，0 禁止请求</p>
                </div>
                <div className="space-y-2">
                  <Label>默认 RPM</Label>
                  <Input type="number" min={-1} value={defaultRpm} onChange={(e) => setDefaultRpm(Number(e.target.value))} />
                  <p className="text-xs text-zinc-500">-1 不限速，0 禁止请求</p>
                </div>
                <div className="space-y-2">
                  <Label>默认 TPM</Label>
                  <Input type="number" min={-1} value={defaultTpm} onChange={(e) => setDefaultTpm(Number(e.target.value))} />
                  <p className="text-xs text-zinc-500">-1 不限速，0 禁止请求</p>
                </div>
                <div className="space-y-2">
                  <Label>默认请求配额</Label>
                  <Input type="number" min={-1} value={defaultQuotaRequests} onChange={(e) => setDefaultQuotaRequests(Number(e.target.value))} />
                  <p className="text-xs text-zinc-500">-1 不限额，0 表示没有可用请求</p>
                </div>
                <div className="space-y-2">
                  <Label>默认 Token 配额</Label>
                  <Input type="number" min={-1} value={defaultQuotaTokens} onChange={(e) => setDefaultQuotaTokens(Number(e.target.value))} />
                  <p className="text-xs text-zinc-500">-1 不限额，0 表示没有可用 Token</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionTitle
                title="上游重试策略"
                description="控制渠道异常时的自动切换行为。"
              />
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-100">开启自动切换</p>
                  <p className="text-xs text-zinc-500">命中 401、429 或 5xx 时尝试其他渠道。</p>
                </div>
                <Switch checked={upstreamRetryEnabled} onCheckedChange={setUpstreamRetryEnabled} />
              </div>
              <div className="space-y-2">
                <Label>最大路由尝试次数</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={upstreamRetryMaxAttempts}
                  onChange={(e) => setUpstreamRetryMaxAttempts(Number(e.target.value))}
                />
                <p className="text-xs text-zinc-500">默认 3，建议不要超过 5，避免上游回退过慢。</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="flex items-center justify-end p-5">
            <Button onClick={save}>保存设置</Button>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
