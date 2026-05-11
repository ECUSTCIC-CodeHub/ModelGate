"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import type { AuthStatus } from "@/lib/auth-status";
import { setCachedProfile, setSession } from "@/lib/client-auth";

export function RegisterForm({ status }: { status: AuthStatus }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const registrationEnabled = status.registration_enabled;
  const oidcEnabled = status.oidc_enabled;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "注册失败，请检查输入信息。") });
        return;
      }

      setSession({ accessToken: data.access_token, refreshToken: data.refresh_token });
      if (data.user) setCachedProfile(data.user);
      toast({ variant: "success", description: getApiMessage(data, "注册成功。") });
      router.push(data.user.role === "admin" ? "/dashboard" : "/dashboard/keys");
    } finally {
      setLoading(false);
    }
  }

  function onOidcLogin() {
    window.location.href = "/api/auth/oidc/authorize";
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-[var(--color-foreground)]">ModelGate</h1>
          <p className="text-sm text-[var(--color-foreground-muted)]">创建账号以继续</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>注册</CardTitle>
            <CardDescription>填写账号信息创建新用户</CardDescription>
          </CardHeader>
          <CardContent>
            {registrationEnabled ? (
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username">用户名</Label>
                  <Input
                    id="username"
                    pattern="[A-Za-z0-9]+"
                    title="仅支持英文字母和数字"
                    placeholder="创建用户名"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">密码</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="设置密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "注册中..." : "注册"}
                </Button>
              </form>
            ) : null}

            {registrationEnabled && oidcEnabled ? (
              <div className="my-4 flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs text-[var(--color-foreground-muted)]">或</span>
                <Separator className="flex-1" />
              </div>
            ) : null}

            {oidcEnabled ? (
              <Button variant={registrationEnabled ? "outline" : "default"} className="w-full" onClick={onOidcLogin}>
                {status.oidc_button_text}
              </Button>
            ) : null}

            <p className="mt-4 text-center text-sm text-[var(--color-foreground-muted)]">
              已有账号？{" "}
              <Link href="/login" className="text-[var(--color-accent)] underline-offset-4 hover:underline transition-colors duration-200 hover:text-[var(--color-accent-hover)]">
                登录
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
