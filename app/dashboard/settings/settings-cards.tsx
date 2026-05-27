"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type ToggleRowProps = {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
};

function ToggleRow({ title, description, checked, onCheckedChange, disabled }: ToggleRowProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-[var(--color-foreground)]">{title}</p>
        <p className="text-xs text-[var(--color-foreground-muted)]">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

function buildDisplayUrl(publicBaseUrl: string, path: string) {
  return (publicBaseUrl.replace(/\/+$/, "") || "https://your-domain.com") + path;
}

export function LoginSettingsCard({
  oidcFeatureEnabled,
  passwordLoginEnabled,
  registrationEnabled,
  setPasswordLoginEnabled,
  setRegistrationEnabled,
}: {
  oidcFeatureEnabled: boolean;
  passwordLoginEnabled: boolean;
  registrationEnabled: boolean;
  setPasswordLoginEnabled: (value: boolean) => void;
  setRegistrationEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="登录与注册"
          description="控制账号密码登录入口与注册开关。限速与配额请前往「用户组」配置。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="允许账号密码登录"
          description={oidcFeatureEnabled ? "关闭后仅支持 OIDC 登录。请确保 OIDC 已配置且有管理员已绑定。" : "当前构建不包含 OIDC，账号密码登录必须保留。"}
          checked={passwordLoginEnabled}
          onCheckedChange={setPasswordLoginEnabled}
          disabled={!oidcFeatureEnabled}
        />
        <ToggleRow
          title="允许账号密码注册"
          description={oidcFeatureEnabled ? "关闭后仅管理员可创建用户，OIDC 自动注册不受影响。" : "关闭后仅管理员可创建用户。"}
          checked={registrationEnabled}
          onCheckedChange={setRegistrationEnabled}
        />
      </CardContent>
    </Card>
  );
}

export function UpstreamSettingsCard({
  upstreamRetryEnabled,
  upstreamRetryMaxAttempts,
  circuitBreakerEnabled,
  setUpstreamRetryEnabled,
  setUpstreamRetryMaxAttempts,
  setCircuitBreakerEnabled,
}: {
  upstreamRetryEnabled: boolean;
  upstreamRetryMaxAttempts: number;
  circuitBreakerEnabled: boolean;
  setUpstreamRetryEnabled: (value: boolean) => void;
  setUpstreamRetryMaxAttempts: (value: number) => void;
  setCircuitBreakerEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="上游重试策略"
          description="控制渠道异常时的自动切换行为。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="开启自动切换"
          description="命中 401、429 或 5xx 时尝试其他渠道。"
          checked={upstreamRetryEnabled}
          onCheckedChange={setUpstreamRetryEnabled}
        />
        <ToggleRow
          title="上游熔断"
          description="连续失败 3 次后暂停该渠道 15 秒，防止雪崩。关闭后所有渠道始终可用。"
          checked={circuitBreakerEnabled}
          onCheckedChange={setCircuitBreakerEnabled}
        />
        <div className="space-y-2">
          <Label>最大路由尝试次数</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={upstreamRetryMaxAttempts}
            onChange={(e) => setUpstreamRetryMaxAttempts(Number(e.target.value))}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">默认 3，建议不要超过 5，避免上游回退过慢。</p>
        </div>
      </CardContent>
    </Card>
  );
}

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

export function CorsSettingsCard({
  corsEnabled,
  setCorsEnabled,
}: {
  corsEnabled: boolean;
  setCorsEnabled: (value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="跨域访问 (CORS)"
          description="允许浏览器端从任意来源调用网关 API。开启后将对所有 /api/v1/* 接口返回 Access-Control-Allow-Origin: *。"
        />
      </CardHeader>
      <CardContent>
        <ToggleRow
          title="允许所有来源跨域"
          description="关闭时浏览器跨域请求会被拦截。仅在需要从前端直连网关时开启。"
          checked={corsEnabled}
          onCheckedChange={setCorsEnabled}
        />
      </CardContent>
    </Card>
  );
}

export function WebhookSettingsCard({
  publicBaseUrl,
  webhookSecret,
  setWebhookSecret,
  copyPublicUrl,
}: {
  publicBaseUrl: string;
  webhookSecret: string;
  setWebhookSecret: (value: string) => void;
  copyPublicUrl: (path: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="Webhook 回调"
          description="接收外部平台的用户变更回调，自动根据角色/标签匹配用户组。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>回调密钥</Label>
          <Input
            type="password"
            placeholder="Webhook Secret"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>回调地址</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground-secondary)]">
              {buildDisplayUrl(publicBaseUrl, "/api/webhook")}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={() => copyPublicUrl("/api/webhook")}>
              复制
            </Button>
          </div>
          <p className="text-xs text-[var(--color-foreground-muted)]">
            支持事件: user.role_change、user.tags_changed、user.identity_change。
            匹配规则使用各用户组的 Claim 表达式（role、tags 字段）。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function AnnouncementSettingsCard({
  announcementContent,
  setAnnouncementContent,
}: {
  announcementContent: string;
  setAnnouncementContent: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="系统公告"
          description="用户登录仪表盘后将弹窗展示公告内容，支持 Markdown 格式。留空则不展示。"
        />
      </CardHeader>
      <CardContent>
        <textarea
          className="flex min-h-40 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
          placeholder={"支持 Markdown，例如：\n# 公告标题\n\n公告正文内容..."}
          value={announcementContent}
          onChange={(e) => setAnnouncementContent(e.target.value)}
          maxLength={5000}
        />
      </CardContent>
    </Card>
  );
}

export function AppearanceSettingsCard({
  logoUrl,
  wallpaperUrl,
  setLogoUrl,
  setWallpaperUrl,
}: {
  logoUrl: string;
  wallpaperUrl: string;
  setLogoUrl: (value: string) => void;
  setWallpaperUrl: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="外观定制"
          description="自定义侧栏 Logo 和全站背景壁纸。留空则不显示对应元素。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Logo 地址</Label>
          <Input
            placeholder="https://example.com/logo.svg"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">侧栏及移动端导航左上角展示的 Logo 图片地址。留空则不显示 Logo。</p>
        </div>
        <div className="space-y-2">
          <Label>壁纸地址</Label>
          <Input
            placeholder="https://example.com/api/wallpaper"
            value={wallpaperUrl}
            onChange={(e) => setWallpaperUrl(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">全站背景壁纸图片地址。支持返回图片的任意 URL（含 302 跳转）。</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function SaveSettingsCard({ onSave }: { onSave: () => void }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-end p-5">
        <Button onClick={onSave}>保存设置</Button>
      </CardContent>
    </Card>
  );
}
