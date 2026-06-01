"use client";

import { Link2, Link2Off, LockKeyhole, LogOut, RefreshCw, Shield, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

type ProfileActionsProps = {
  oidcAvailable: boolean;
  oidcBound: boolean;
  totpEnabled: boolean;
  onChangePassword: () => void;
  onOidcBind: () => void;
  onOidcSync: () => void;
  onOidcUnbind: () => void;
  onTotpManage: () => void;
  onLogout: () => void;
};

function ActionButton({
  children,
  destructive,
  onClick,
}: {
  children: ReactNode;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        destructive
          ? "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--color-destructive)] transition-colors duration-150 hover:bg-[var(--color-destructive-muted)] hover:text-[var(--color-destructive-hover)]"
          : "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--color-foreground-muted)] transition-colors duration-150 hover:bg-[var(--color-bg)]/60 hover:text-[var(--color-foreground)]"
      }
    >
      {children}
    </button>
  );
}

export function ProfileActions({
  oidcAvailable,
  oidcBound,
  totpEnabled,
  onChangePassword,
  onOidcBind,
  onOidcSync,
  onOidcUnbind,
  onTotpManage,
  onLogout,
}: ProfileActionsProps) {
  return (
    <div className="space-y-1">
      <ActionButton onClick={onChangePassword}>
        <LockKeyhole className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">修改密码</span>
      </ActionButton>
      <ActionButton onClick={onTotpManage}>
        {totpEnabled ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <Shield className="h-4 w-4 shrink-0" />}
        <span className="flex-1 text-left">{totpEnabled ? "双因素认证" : "双因素认证"}</span>
        <span className={`text-[10px] ${totpEnabled ? "text-[var(--color-accent)]" : "text-[var(--color-foreground-subtle)]"}`}>
          {totpEnabled ? "已启用" : "未启用"}
        </span>
      </ActionButton>
      {oidcAvailable && oidcBound ? (
        <>
          <ActionButton onClick={onOidcSync}>
            <RefreshCw className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">同步 OIDC</span>
            <span className="text-[10px] text-[var(--color-accent)]">已绑定</span>
          </ActionButton>
          <ActionButton onClick={onOidcUnbind}>
            <Link2Off className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">解绑 OIDC</span>
          </ActionButton>
        </>
      ) : null}
      {oidcAvailable && !oidcBound ? (
        <ActionButton onClick={onOidcBind}>
          <Link2 className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">绑定 OIDC</span>
          <span className="text-[10px] text-[var(--color-foreground-subtle)]">未绑定</span>
        </ActionButton>
      ) : null}
      <ActionButton destructive onClick={onLogout}>
        <LogOut className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">退出登录</span>
      </ActionButton>
    </div>
  );
}
