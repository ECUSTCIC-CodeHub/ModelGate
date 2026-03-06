/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession } from "@/lib/client-auth";

export default function AdminSettingsPage() {
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [defaultQps, setDefaultQps] = useState(1);
  const [defaultRpm, setDefaultRpm] = useState(60);
  const [defaultTpm, setDefaultTpm] = useState(60000);
  const { toast } = useToast();

  async function ensureAdmin() {
    const me = await authedFetch("/api/dashboard/profile");
    if (!me.ok) {
      clearSession();
      window.location.href = "/login";
      return false;
    }
    const data = await me.json();
    if (data.user.role !== "admin") {
      window.location.href = "/dashboard/keys";
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
      setDefaultQps(Number(data.data.default_qps ?? 1));
      setDefaultRpm(Number(data.data.default_rpm ?? 60));
      setDefaultTpm(Number(data.data.default_tpm ?? 60000));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    const response = await authedFetch("/api/dashboard/settings", {
      method: "PUT",
      body: JSON.stringify({
        registration_enabled: registrationEnabled,
        default_qps: defaultQps,
        default_rpm: defaultRpm,
        default_tpm: defaultTpm,
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
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>注册开关</CardTitle>
          <CardDescription>控制是否允许新用户在注册页自助注册。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-zinc-100">开启公开注册</p>
              <p className="text-xs text-zinc-500">关闭后只能由管理员创建用户。</p>
            </div>
            <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <p className="text-sm text-zinc-300">默认 QPS</p>
              <input
                type="number"
                min={1}
                className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                value={defaultQps}
                onChange={(e) => setDefaultQps(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm text-zinc-300">默认 RPM</p>
              <input
                type="number"
                min={1}
                className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                value={defaultRpm}
                onChange={(e) => setDefaultRpm(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm text-zinc-300">默认 TPM</p>
              <input
                type="number"
                min={1}
                className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                value={defaultTpm}
                onChange={(e) => setDefaultTpm(Number(e.target.value))}
              />
            </div>
          </div>
          <Button onClick={save}>保存设置</Button>
        </CardContent>
      </Card>
    </DashboardShell>
  );
}
