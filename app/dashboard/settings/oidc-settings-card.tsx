"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildDisplayUrl, ToggleRow } from "./settings-card-utils";

export function OidcSettingsCard({
  oidcEnabled,
  oidcIssuerUrl,
  oidcClientId,
  oidcClientSecret,
  oidcScopes,
  oidcAutoRegister,
  oidcButtonText,
  publicBaseUrl,
  setOidcEnabled,
  setOidcIssuerUrl,
  setOidcClientId,
  setOidcClientSecret,
  setOidcScopes,
  setOidcAutoRegister,
  setOidcButtonText,
  setPublicBaseUrl,
  copyPublicUrl,
}: {
  oidcEnabled: boolean;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcScopes: string;
  oidcAutoRegister: boolean;
  oidcButtonText: string;
  publicBaseUrl: string;
  setOidcEnabled: (value: boolean) => void;
  setOidcIssuerUrl: (value: string) => void;
  setOidcClientId: (value: string) => void;
  setOidcClientSecret: (value: string) => void;
  setOidcScopes: (value: string) => void;
  setOidcAutoRegister: (value: boolean) => void;
  setOidcButtonText: (value: string) => void;
  setPublicBaseUrl: (value: string) => void;
  copyPublicUrl: (path: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="OIDC 单点登录"
          description="配置通用 OIDC 提供商，支持用户通过第三方身份系统登录。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="启用 OIDC 登录"
          description="开启后登录页将显示 OIDC 登录按钮。"
          checked={oidcEnabled}
          onCheckedChange={setOidcEnabled}
        />
        <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3">
          <div className="space-y-2">
            <Label>对外服务域名</Label>
            <Input
              placeholder="https://your-domain.com"
              value={publicBaseUrl}
              onChange={(e) => setPublicBaseUrl(e.target.value)}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">实际对外提供服务的协议+域名（不含路径）。用于 OIDC 回调、绑定跳转等所有需要绝对 URL 的场景。默认按当前页面 origin 自动填充。</p>
          </div>
          <div className="space-y-2">
            <Label>回调地址 (Redirect URI)</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground-secondary)]">
                {buildDisplayUrl(publicBaseUrl, "/api/auth/oidc/callback")}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={() => copyPublicUrl("/api/auth/oidc/callback")}>
                复制
              </Button>
            </div>
            <p className="text-xs text-[var(--color-foreground-muted)]">由对外服务域名自动派生，在 OIDC 提供商中配置此地址作为允许的回调 URI。</p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Issuer URL</Label>
            <Input
              placeholder="https://accounts.example.com"
              value={oidcIssuerUrl}
              onChange={(e) => setOidcIssuerUrl(e.target.value)}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">OIDC 提供商的 Issuer 地址，需支持 .well-known/openid-configuration</p>
          </div>
          <div className="space-y-2">
            <Label>Client ID</Label>
            <Input
              placeholder="your-client-id"
              value={oidcClientId}
              onChange={(e) => setOidcClientId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Client Secret</Label>
            <Input
              type="password"
              placeholder="your-client-secret"
              value={oidcClientSecret}
              onChange={(e) => setOidcClientSecret(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Scopes</Label>
            <Input
              placeholder="openid profile email"
              value={oidcScopes}
              onChange={(e) => setOidcScopes(e.target.value)}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">空格分隔，至少包含 openid</p>
          </div>
          <div className="space-y-2">
            <Label>登录按钮文字</Label>
            <Input
              placeholder="OIDC 登录"
              value={oidcButtonText}
              onChange={(e) => setOidcButtonText(e.target.value)}
            />
          </div>
        </div>
        <ToggleRow
          title="自动注册"
          description="首次 OIDC 登录时自动创建用户。关闭后需先由管理员创建账号并绑定 OIDC。"
          checked={oidcAutoRegister}
          onCheckedChange={setOidcAutoRegister}
        />
      </CardContent>
    </Card>
  );
}
