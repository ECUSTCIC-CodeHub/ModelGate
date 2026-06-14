"use client";

import { Cog, KeyRound, Megaphone, ShieldCheck, Sparkles, Users, Waypoints } from "lucide-react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type DashboardQuickActionsCardProps = {
  isAdmin: boolean;
  announcementEnabled: boolean;
  onNavigate: (href: string) => void;
};

export function DashboardQuickActionsCard({ isAdmin, announcementEnabled, onNavigate }: DashboardQuickActionsCardProps) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle title="快捷入口" description="常用操作集中在这里处理。" />
      </CardHeader>
      <CardContent className="grid gap-2">
        <Button onClick={() => onNavigate("/dashboard/keys")}>
          <KeyRound className="h-4 w-4" />
          创建或管理 Key
        </Button>
        <Button variant="outline" onClick={() => onNavigate("/dashboard/logs")}>
          <Sparkles className="h-4 w-4" />
          查看请求日志
        </Button>
        <Button variant="outline" onClick={() => onNavigate("/dashboard/models")}>
          <ShieldCheck className="h-4 w-4" />
          查看可用模型
        </Button>
        {announcementEnabled ? (
          <Button variant="outline" onClick={() => window.dispatchEvent(new CustomEvent("announcement:reopen"))}>
            <Megaphone className="h-4 w-4" />
            查看公告
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="outline" onClick={() => onNavigate("/dashboard/channels")}>
            <Waypoints className="h-4 w-4" />
            管理接口与模型
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="outline" onClick={() => onNavigate("/dashboard/users")}>
            <Users className="h-4 w-4" />
            用户管理
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="outline" onClick={() => onNavigate("/dashboard/settings")}>
            <Cog className="h-4 w-4" />
            系统设置
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
