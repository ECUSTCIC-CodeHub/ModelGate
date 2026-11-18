import * as React from "react";
import { cn } from "@/lib/shared/utils";

/** 卡片宽度档位。收窄成枚举，避免误传 `w-96` 这类与 `w-full` 冲突的类名被 twMerge 静默吞掉。 */
const WIDTHS = {
  narrow: "max-w-sm",
  wide: "max-w-md",
} as const;

/**
 * 登录 / 注册 / OIDC 绑定 / DSH 授权等「应用外壳之外」的页面共用的版式：
 * 居中一列，顶部是 ModelGate 字标与一行副标题，下方由调用方放卡片。
 *
 * 背景由 globals.css 的 body::before 统一提供（主题色渐变 + 网格），
 * 所以这里只负责排布，不画背景，页面之间才不会出现两套底色。
 */
export function AuthShell({
  subtitle,
  width = "narrow",
  children,
}: {
  subtitle?: React.ReactNode;
  /** 窄卡片用 narrow（默认），带兑换码或说明的页面用 wide。 */
  width?: keyof typeof WIDTHS;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className={cn("w-full space-y-6", WIDTHS[width])}>
        <div className="space-y-2 text-center">
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-[var(--color-foreground)]">ModelGate</h1>
          {subtitle ? <p className="text-sm text-[var(--color-foreground-muted)]">{subtitle}</p> : null}
        </div>
        {children}
      </div>
    </main>
  );
}
