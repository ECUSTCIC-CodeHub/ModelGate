"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { setCachedProfile, setSession } from "@/lib/client-auth";

export function BindForm() {
  const router = useRouter();
  const [tab, setTab] = useState<"link" | "create">("create");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function onLink(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
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
      setSession({ accessToken: data.access_token, refreshToken: data.refresh_token });
      if (data.user) setCachedProfile(data.user);
      router.push(data.user.role === "admin" ? "/dashboard" : "/dashboard/keys");
    } finally {
      setLoading(false);
    }
  }

  async function onCreate() {
    setLoading(true);
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
      setSession({ accessToken: data.access_token, refreshToken: data.refresh_token });
      if (data.user) setCachedProfile(data.user);
      toast({ variant: "success", description: getApiMessage(data, "账号创建成功。") });
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
          <p className="text-sm text-zinc-400">OIDC 身份验证成功，请绑定或创建账号</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>绑定账号</CardTitle>
            <CardDescription>
              {tab === "link" ? "输入已有账号的用户名和密码进行绑定" : "使用 OIDC 身份直接创建新账号"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant={tab === "create" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setTab("create")}
              >
                创建新账号
              </Button>
              <Button
                type="button"
                variant={tab === "link" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setTab("link")}
              >
                绑定已有账号
              </Button>
            </div>

            <Separator />

            {tab === "create" ? (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  将使用您的 OIDC 身份信息自动创建账号，创建后可在设置中修改密码。
                </p>
                <Button className="w-full" onClick={onCreate} disabled={loading}>
                  {loading ? "创建中..." : "立即创建"}
                </Button>
              </div>
            ) : (
              <form onSubmit={onLink} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username">用户名</Label>
                  <Input
                    id="username"
                    placeholder="输入已有账号的用户名"
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
                  {loading ? "绑定中..." : "绑定账号"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
