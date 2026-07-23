import {
  Boxes,
  Gauge,
  KeyRound,
  LayoutGrid,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  UserCog,
  Users,
  Waypoints,
} from "lucide-react";
import type { DashboardMenuItem, Role } from "@/components/layout/dashboard-shell/types";

const adminMenus: DashboardMenuItem[] = [
  { href: "/dashboard", label: "首页概览", icon: LayoutGrid },
  { href: "/dashboard/logs", label: "请求日志", icon: Sparkles },
  { href: "/dashboard/keys", label: "密钥管理", icon: KeyRound },
  { href: "/dashboard/quota", label: "配额与限制", icon: Gauge },
  { href: "/dashboard/models", label: "模型列表", icon: Boxes },
  { href: "/dashboard/access", label: "接入指南", icon: Shield },
  { href: "/dashboard/channels", label: "渠道管理", icon: Waypoints },
  { href: "/dashboard/users", label: "用户管理", icon: UserCog },
  { href: "/dashboard/groups", label: "用户组管理", icon: Users },
  { href: "/dashboard/personal-settings", label: "个人设置", icon: SlidersHorizontal },
  { href: "/dashboard/settings", label: "系统设置", icon: Settings2 },
];

const userMenus: DashboardMenuItem[] = [
  { href: "/dashboard", label: "首页概览", icon: LayoutGrid },
  { href: "/dashboard/logs", label: "请求日志", icon: Sparkles },
  { href: "/dashboard/keys", label: "密钥管理", icon: KeyRound },
  { href: "/dashboard/quota", label: "配额与限制", icon: Gauge },
  { href: "/dashboard/models", label: "模型列表", icon: Boxes },
  { href: "/dashboard/access", label: "接入指南", icon: Shield },
  { href: "/dashboard/personal-settings", label: "个人设置", icon: SlidersHorizontal },
];

export function getDashboardMenus(role: Role) {
  return role === "admin" ? adminMenus : userMenus;
}
