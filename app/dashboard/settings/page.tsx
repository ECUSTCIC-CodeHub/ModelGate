/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <DashboardShell role="admin" title="系统设置" subtitle="全局开关与注册策略">
      <div className="h-full min-h-0 overflow-y-auto pr-1">
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>注册与默认限流</CardTitle>
              <CardDescription>新用户注册策略与默认 QPS/RPM/TPM/配额配置</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">开启公开注册</p>
                  <p className="text-xs text-zinc-500">关闭后只能由管理员创建用户。</p>
                </div>
                <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
              </div>
              <div className="grid gap-3 md:grid-cols-5">
                <div className="space-y-2">
                  <p className="text-sm text-zinc-300">默认 QPS</p>
                  <input
                    type="number"
                    min={-1}
                    className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                    value={defaultQps}
                    onChange={(e) => setDefaultQps(Number(e.target.value))}
                  />
                  <p className="text-xs text-zinc-500">-1 表示不限速，0 表示禁止请求</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-zinc-300">默认 RPM</p>
                  <input
                    type="number"
                    min={-1}
                    className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                    value={defaultRpm}
                    onChange={(e) => setDefaultRpm(Number(e.target.value))}
                  />
                  <p className="text-xs text-zinc-500">-1 表示不限速，0 表示禁止请求</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-zinc-300">默认 TPM</p>
                  <input
                    type="number"
                    min={-1}
                    className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                    value={defaultTpm}
                    onChange={(e) => setDefaultTpm(Number(e.target.value))}
                  />
                  <p className="text-xs text-zinc-500">-1 表示不限速，0 表示禁止请求</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-zinc-300">默认请求配额</p>
                  <input
                    type="number"
                    min={-1}
                    className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                    value={defaultQuotaRequests}
                    onChange={(e) => setDefaultQuotaRequests(Number(e.target.value))}
                  />
                  <p className="text-xs text-zinc-500">-1 表示不限额，0 表示无可用请求</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-zinc-300">默认 Token 配额</p>
                  <input
                    type="number"
                    min={-1}
                    className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                    value={defaultQuotaTokens}
                    onChange={(e) => setDefaultQuotaTokens(Number(e.target.value))}
                  />
                  <p className="text-xs text-zinc-500">-1 表示不限额，0 表示无可用 Token</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>上游重试策略</CardTitle>
              <CardDescription>当上游异常时，自动切换其他渠道</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">开启自动切换</p>
                  <p className="text-xs text-zinc-500">命中 401/429/5xx 时尝试其他渠道。</p>
                </div>
                <Switch checked={upstreamRetryEnabled} onCheckedChange={setUpstreamRetryEnabled} />
              </div>
              <div className="space-y-2">
                <p className="text-sm text-zinc-300">最大路由尝试次数</p>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                  value={upstreamRetryMaxAttempts}
                  onChange={(e) => setUpstreamRetryMaxAttempts(Number(e.target.value))}
                />
                <p className="text-xs text-zinc-500">默认 3，最多尝试 3 个渠道后返回错误。</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-4">
          <CardContent className="flex items-center justify-end p-4">
            <Button onClick={save}>保存设置</Button>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
