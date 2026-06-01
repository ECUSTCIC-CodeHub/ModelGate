"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";
import { setCachedProfile, setSession } from "@/lib/auth/client-auth";

function handleSuccess(data: Record<string, unknown>) {
  setSession({ accessToken: data.access_token as string, refreshToken: data.refresh_token as string });
  if (data.user) setCachedProfile(data.user as Parameters<typeof setCachedProfile>[0]);
  const role = (data.user as Record<string, unknown>)?.role;
  window.location.href = role === "admin" ? "/dashboard" : "/dashboard/keys";
}

export function BindForm({ allowCreate }: { allowCreate: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loadingLink, setLoadingLink] = useState(false);
  const [loadingCreate, setLoadingCreate] = useState(false);
  const { toast } = useToast();

  async function onLink(event: FormEvent) {
    event.preventDefault();
    setLoadingLink(true);
    try {
      const response = await fetch("/api/auth/oidc/bind-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "link", username, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "绑定失败。") });
        return;
      }
      handleSuccess(data);
    } finally {
      setLoadingLink(false);
    }
  }

  async function onCreate() {
    setLoadingCreate(true);
    try {
      const response = await fetch("/api/auth/oidc/bind-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "create" }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "创建失败。") });
        return;
      }
      handleSuccess(data);
    } finally {
      setLoadingCreate(false);
    }
  }

  const loading = loadingLink || loadingCreate;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-foreground)]">ModelGate</h1>
          <p className="text-sm text-[var(--color-foreground-muted)]">OIDC 身份验证成功，请选择以下方式继续</p>
        </div>

        {allowCreate ? (
          <Card>
            <CardHeader>
              <CardTitle>快速注册</CardTitle>
              <CardDescription>使用 OIDC 身份信息自动创建新账号</CardDescription>
            </CardHeader>
            <CardContent>
              <Button className="w-full" onClick={onCreate} disabled={loading}>
                {loadingCreate ? "创建中..." : "一键创建账号"}
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {allowCreate ? (
          <div className="flex items-center gap-3 px-2">
            <div className="h-px flex-1 bg-[var(--color-border)]" />
            <span className="text-xs text-[var(--color-foreground-muted)]">或</span>
            <div className="h-px flex-1 bg-[var(--color-border)]" />
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{allowCreate ? "绑定已有账号" : "绑定账号"}</CardTitle>
            <CardDescription>输入已有账号的用户名和密码，将 OIDC 身份关联到该账号</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onLink} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  placeholder="输入已有账号的用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>
              <Button type="submit" variant={allowCreate ? "outline" : "default"} className="w-full" disabled={loading}>
                {loadingLink ? "绑定中..." : "绑定账号"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
