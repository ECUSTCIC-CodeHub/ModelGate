import {
  Boxes,
  Gauge,
  KeyRound,
  LayoutGrid,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Ticket,
  UserCog,
  Users,
  Waypoints,
} from "lucide-react";
import type { DashboardMenuItem, Role } from "@/components/layout/dashboard-shell/types";
import { modelGateFeatures } from "@/lib/core/features";

// 兑换码管理入口仅在功能开启时出现（管理员侧）。
const redeemMenusEnabled = modelGateFeatures.redeemCode;

const adminMenus: DashboardMenuItem[] = [
  { href: "/dashboard", label: "首页概览", icon: LayoutGrid },
  { href: "/dashboard/logs", label: "请求日志", icon: Sparkles },
  { href: "/dashboard/keys", label: "密钥管理", icon: KeyRound },
  { href: "/dashboard/quota", label: "配额与限制", icon: Gauge },
  { href: "/dashboard/models", label: "模型列表", icon: Boxes },
  { href: "/dashboard/access", label: "接入指南", icon: Shield },
  { href: "/dashboard/channels", label: "渠道管理", icon: Waypoints },
  { href: "/dashboard/users", label: "用户管理", icon: UserCog },
  ...(redeemMenusEnabled
    ? [
        { href: "/dashboard/redeem", label: "兑换码", icon: Ticket },
        { href: "/dashboard/redeem-codes", label: "兑换码管理", icon: Ticket },
      ]
    : []),
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

// 普通用户的兑换入口按需出现：只有已经持有定向额度（兑换过或管理员发放）时才展示，
// 避免未参与活动的用户被一个用不上的入口打扰；管理员可在「兑换码管理」页自行进入。
export function withRedeemEntry(menus: DashboardMenuItem[], showRedeemEntry: boolean): DashboardMenuItem[] {
  if (!modelGateFeatures.redeemCode || !showRedeemEntry || menus.some((m) => m.href === "/dashboard/redeem")) return menus;
  const accessIndex = menus.findIndex((m) => m.href === "/dashboard/access");
  const entry = { href: "/dashboard/redeem", label: "兑换码", icon: Ticket };
  if (accessIndex < 0) return [...menus, entry];
  return [...menus.slice(0, accessIndex), entry, ...menus.slice(accessIndex)];
}
