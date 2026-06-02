"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { TotpCodeInput } from "@/components/auth/totp-code-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";
import type { AuthStatus } from "@/lib/auth/auth-status";
import { setCachedProfile, setSession } from "@/lib/auth/client-auth";

export function LoginForm({ status }: { status: AuthStatus }) {
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { toast } = useToast();

  const oidcError = searchParams.get("oidc_error");
  const totpRequiredParam = searchParams.get("totp_required");
  const pendingTokenParam = searchParams.get("pending_token");
  const [loading, setLoading] = useState(false);
  const [totpRequired, setTotpRequired] = useState(() => totpRequiredParam === "1" && Boolean(pendingTokenParam));
  const [pendingToken, setPendingToken] = useState(() => pendingTokenParam ?? "");
  const [totpCode, setTotpCode] = useState("");

  const passwordEnabled = status.password_login_enabled;
  const oidcEnabled = status.oidc_enabled;
  const registrationEnabled = status.registration_enabled;

  function handleLoginSuccess(data: { access_token: string; refresh_token: string; user: { role: string } }) {
    setSession({ accessToken: data.access_token, refreshToken: data.refresh_token });
    if ("user" in data && data.user) setCachedProfile(data.user as Parameters<typeof setCachedProfile>[0]);
    window.location.href = (data.user as { role: string }).role === "admin" ? "/dashboard" : "/dashboard/keys";
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "登录失败，请检查账号密码。") });
        return;
      }

      if (data.totp_required) {
        setPendingToken(data.pending_token);
        setTotpRequired(true);
        return;
      }

      handleLoginSuccess(data);
    } finally {
      setLoading(false);
    }
  }

  async function onTotpSubmit(event: FormEvent) {
    event.preventDefault();
    if (totpCode.length !== 6) return;
    setLoading(true);

    try {
      const response = await fetch("/api/auth/totp/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pending_token: pendingToken, code: totpCode }),
      });

      const data = await response.json();
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "验证码错误。") });
        return;
      }

      handleLoginSuccess(data);
    } finally {
      setLoading(false);
    }
  }

  function onOidcLogin() {
    window.location.href = "/api/auth/oidc/authorize";
  }

  function onBackToLogin() {
    setTotpRequired(false);
    setPendingToken("");
    setTotpCode("");
  }

  if (totpRequired) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="font-mono text-2xl font-semibold tracking-tight text-[var(--color-foreground)]">ModelGate</h1>
            <p className="text-sm text-[var(--color-foreground-muted)]">二次验证</p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>输入验证码</CardTitle>
              <CardDescription>输入验证器中的 6 位验证码。</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onTotpSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="totp_code">验证码</Label>
                  <TotpCodeInput
                    id="totp_code"
                    value={totpCode}
                    onChange={setTotpCode}
                    required
                    autoFocus
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading || totpCode.length !== 6}>
                  {loading ? "验证中..." : "验证"}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={onBackToLogin}>
                  返回登录
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-[var(--color-foreground)]">ModelGate</h1>
          <p className="text-sm text-[var(--color-foreground-muted)]">登录管理控制台</p>
        </div>
        {oidcError ? (
          <div className="rounded-xl border border-[var(--color-destructive-border)] bg-[var(--color-destructive-muted)] px-4 py-3 text-sm text-[var(--color-destructive)]">
            {oidcError}
          </div>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>登录</CardTitle>
            <CardDescription>
              {passwordEnabled && oidcEnabled
                ? "使用账号密码或 OIDC 登录"
                : passwordEnabled
                  ? "输入账号密码继续"
                  : oidcEnabled
                    ? "使用 OIDC 账号登录"
                    : "登录"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {passwordEnabled ? (
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username">用户名</Label>
                  <Input
                    id="username"
                    pattern="[A-Za-z0-9]+"
                    title="仅支持英文字母和数字"
                    placeholder="输入用户名"
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
                    placeholder="输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "登录中..." : "登录"}
                </Button>
              </form>
            ) : null}

            {passwordEnabled && oidcEnabled ? (
              <div className="my-4 flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs text-[var(--color-foreground-muted)]">或</span>
                <Separator className="flex-1" />
              </div>
            ) : null}

            {oidcEnabled ? (
              <Button variant={passwordEnabled ? "outline" : "default"} className="w-full" onClick={onOidcLogin}>
                {status.oidc_button_text}
              </Button>
            ) : null}

            {passwordEnabled && registrationEnabled ? (
              <p className="mt-4 text-center text-sm text-[var(--color-foreground-muted)]">
                还没有账号？{" "}
                <Link href="/register" className="text-[var(--color-accent)] underline-offset-4 hover:underline transition-colors duration-200 hover:text-[var(--color-accent-hover)]">
                  注册
                </Link>
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
