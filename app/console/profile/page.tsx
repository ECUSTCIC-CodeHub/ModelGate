/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch, clearSession } from "@/lib/client-auth";

type User = {
  id: number;
  username: string;
  role: "admin" | "user";
  rpm: number;
  qps: number;
  tpm: number;
};

export default function ConsoleProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<"admin" | "user">("user");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const { toast } = useToast();

  async function load() {
    const me = await authedFetch("/api/dashboard/profile");
    if (!me.ok) {
      clearSession();
      router.push("/login");
      return;
    }
    const data = await me.json();
    setUser(data.user);
    setRole(data.user.role);
  }

  useEffect(() => {
    void load();
  }, [router]);

  async function onChangePassword(event: FormEvent) {
    event.preventDefault();
    const response = await authedFetch("/api/dashboard/profile/password", {
      method: "PUT",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    const data = await response.json();
    if (!response.ok) {
      toast({ variant: "error", description: getApiMessage(data, "密码修改失败。") });
      return;
    }
    toast({ variant: "success", description: getApiMessage(data, "密码修改成功。") });
    setCurrentPassword("");
    setNewPassword("");
  }

  return (
    <DashboardShell role={role} title="个人资料" subtitle="账号安全与限制参数">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>账户信息</CardTitle>
            <CardDescription>当前登录用户信息</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-zinc-300">
            {!user ? (
              <p>Loading...</p>
            ) : (
              <>
                <p><span className="font-medium text-zinc-100">用户名：</span>{user.username}</p>
                <p><span className="font-medium text-zinc-100">角色：</span>{user.role === "admin" ? "管理员" : "普通用户"}</p>
                <p><span className="font-medium text-zinc-100">RPM/QPS/TPM：</span>{user.rpm}/{user.qps}/{user.tpm}</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>修改密码</CardTitle>
            <CardDescription>建议使用高强度密码。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onChangePassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current_password">当前密码</Label>
                <Input
                  id="current_password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new_password">新密码</Label>
                <Input
                  id="new_password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <Button type="submit">更新密码</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
