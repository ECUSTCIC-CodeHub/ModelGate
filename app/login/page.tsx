"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { setCachedProfile, setSession } from "@/lib/client-auth";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

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

      setSession({ accessToken: data.access_token, refreshToken: data.refresh_token });
      if (data.user) setCachedProfile(data.user);
      router.push(data.user.role === "admin" ? "/dashboard" : "/dashboard/keys");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">ModelGate</h1>
          <p className="text-sm text-zinc-400">登录管理控制台</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>登录</CardTitle>
            <CardDescription>输入账号密码继续</CardDescription>
          </CardHeader>
          <CardContent>
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
            <p className="mt-4 text-center text-sm text-zinc-400">
              还没有账号？{" "}
              <Link href="/register" className="text-zinc-100 underline-offset-4 hover:underline">
                注册
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
