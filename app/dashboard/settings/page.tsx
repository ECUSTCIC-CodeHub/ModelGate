"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SectionTitle } from "@/components/dashboard/section-title";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureAdmin } from "@/lib/auth/client-auth";
import { modelGateFeatures } from "@/lib/core/features";

export default function AdminSettingsPage() {
  const router = useRouter();
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true);
  const [upstreamRetryEnabled, setUpstreamRetryEnabled] = useState(true);
  const [upstreamRetryMaxAttempts, setUpstreamRetryMaxAttempts] = useState(3);
  const [circuitBreakerEnabled, setCircuitBreakerEnabled] = useState(true);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcIssuerUrl, setOidcIssuerUrl] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcScopes, setOidcScopes] = useState("openid profile email");
  const [oidcAutoRegister, setOidcAutoRegister] = useState(true);
  const [oidcButtonText, setOidcButtonText] = useState("OIDC 登录");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [announcementContent, setAnnouncementContent] = useState("");
  const [wallpaperUrl, setWallpaperUrl] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [corsEnabled, setCorsEnabled] = useState(false);
  const { toast } = useToast();
  const oidcFeatureEnabled = modelGateFeatures.oidc;
  const announcementFeatureEnabled = modelGateFeatures.announcement;
  const webhookFeatureEnabled = modelGateFeatures.webhook;

  async function load() {
    if (!(await ensureAdmin(router))) return;
    const response = await authedFetch("/api/dashboard/settings");
    const data = await response.json();
    if (response.ok) {
      setRegistrationEnabled(data.data.registration_enabled === 1);
      setPasswordLoginEnabled(data.data.password_login_enabled !== 0);
      setUpstreamRetryEnabled(data.data.upstream_retry_enabled !== 0);
      setUpstreamRetryMaxAttempts(Number(data.data.upstream_retry_max_attempts ?? 3));
      setCircuitBreakerEnabled(data.data.upstream_circuit_breaker_enabled !== 0);
      if (oidcFeatureEnabled) {
        setOidcEnabled(data.data.oidc_enabled === 1);
        setOidcIssuerUrl(data.data.oidc_issuer_url ?? "");
        setOidcClientId(data.data.oidc_client_id ?? "");
        setOidcClientSecret(data.data.oidc_client_secret ?? "");
        setOidcScopes(data.data.oidc_scopes ?? "openid profile email");
        setOidcAutoRegister(data.data.oidc_auto_register !== 0);
        setOidcButtonText(data.data.oidc_button_text ?? "OIDC 登录");
      }
      const savedBase = data.data.public_base_url ?? "";
      setPublicBaseUrl(
        savedBase || (typeof window !== "undefined" ? window.location.origin : ""),
      );
      if (announcementFeatureEnabled) setAnnouncementContent(data.data.announcement_content ?? "");
      setWallpaperUrl(data.data.wallpaper_url ?? "");
      setLogoUrl(data.data.logo_url ?? "");
      if (webhookFeatureEnabled) setWebhookSecret(data.data.webhook_secret ?? "");
      setCorsEnabled(data.data.cors_enabled === 1);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const profile = await ensureAdmin(router);
      if (cancelled || !profile) return;
      const response = await authedFetch("/api/dashboard/settings");
      if (cancelled) return;
      const data = await response.json();
      if (cancelled) return;
      if (response.ok) {
        setRegistrationEnabled(data.data.registration_enabled === 1);
        setPasswordLoginEnabled(data.data.password_login_enabled !== 0);
        setUpstreamRetryEnabled(data.data.upstream_retry_enabled !== 0);
        setUpstreamRetryMaxAttempts(Number(data.data.upstream_retry_max_attempts ?? 3));
        setCircuitBreakerEnabled(data.data.upstream_circuit_breaker_enabled !== 0);
        if (oidcFeatureEnabled) {
          setOidcEnabled(data.data.oidc_enabled === 1);
          setOidcIssuerUrl(data.data.oidc_issuer_url ?? "");
          setOidcClientId(data.data.oidc_client_id ?? "");
          setOidcClientSecret(data.data.oidc_client_secret ?? "");
          setOidcScopes(data.data.oidc_scopes ?? "openid profile email");
          setOidcAutoRegister(data.data.oidc_auto_register !== 0);
          setOidcButtonText(data.data.oidc_button_text ?? "OIDC 登录");
        }
        const savedBase = data.data.public_base_url ?? "";
        setPublicBaseUrl(
          savedBase || (typeof window !== "undefined" ? window.location.origin : ""),
        );
        if (announcementFeatureEnabled) setAnnouncementContent(data.data.announcement_content ?? "");
        setWallpaperUrl(data.data.wallpaper_url ?? "");
        setLogoUrl(data.data.logo_url ?? "");
        if (webhookFeatureEnabled) setWebhookSecret(data.data.webhook_secret ?? "");
        setCorsEnabled(data.data.cors_enabled === 1);
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [announcementFeatureEnabled, oidcFeatureEnabled, router, webhookFeatureEnabled]);

  async function save() {
    const payload = {
      registration_enabled: registrationEnabled,
      password_login_enabled: passwordLoginEnabled,
      upstream_retry_enabled: upstreamRetryEnabled,
      upstream_retry_max_attempts: upstreamRetryMaxAttempts,
      upstream_circuit_breaker_enabled: circuitBreakerEnabled,
      ...(oidcFeatureEnabled ? {
        oidc_enabled: oidcEnabled,
        oidc_issuer_url: oidcIssuerUrl,
        oidc_client_id: oidcClientId,
        oidc_client_secret: oidcClientSecret,
        oidc_scopes: oidcScopes,
        oidc_auto_register: oidcAutoRegister,
        oidc_button_text: oidcButtonText,
      } : {}),
      public_base_url: publicBaseUrl,
      ...(announcementFeatureEnabled ? { announcement_content: announcementContent } : {}),
      wallpaper_url: wallpaperUrl,
      logo_url: logoUrl,
      ...(webhookFeatureEnabled ? { webhook_secret: webhookSecret } : {}),
      cors_enabled: corsEnabled,
    };

    const response = await authedFetch("/api/dashboard/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "保存成功。") });
      void load();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "保存失败。") });
  }

  return (
    <DashboardShell
      role="admin"
      title="系统设置"
      subtitle={oidcFeatureEnabled ? "配置登录注册策略、上游重试与 OIDC 单点登录。" : "配置登录注册策略与上游重试。"}
    >
      <div className="space-y-4 pb-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <Card>
            <CardHeader>
              <SectionTitle
                title="登录与注册"
                description="控制账号密码登录入口与注册开关。限速与配额请前往「用户组」配置。"
              />
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">允许账号密码登录</p>
                  <p className="text-xs text-[var(--color-foreground-muted)]">
                    {oidcFeatureEnabled ? "关闭后仅支持 OIDC 登录。请确保 OIDC 已配置且有管理员已绑定。" : "当前构建不包含 OIDC，账号密码登录必须保留。"}
                  </p>
                </div>
                <Switch checked={passwordLoginEnabled} onCheckedChange={setPasswordLoginEnabled} disabled={!oidcFeatureEnabled} />
              </div>
              <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">允许账号密码注册</p>
                  <p className="text-xs text-[var(--color-foreground-muted)]">
                    {oidcFeatureEnabled ? "关闭后仅管理员可创建用户，OIDC 自动注册不受影响。" : "关闭后仅管理员可创建用户。"}
                  </p>
                </div>
                <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionTitle
                title="上游重试策略"
                description="控制渠道异常时的自动切换行为。"
              />
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">开启自动切换</p>
                  <p className="text-xs text-[var(--color-foreground-muted)]">命中 401、429 或 5xx 时尝试其他渠道。</p>
                </div>
                <Switch checked={upstreamRetryEnabled} onCheckedChange={setUpstreamRetryEnabled} />
              </div>
              <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">上游熔断</p>
                  <p className="text-xs text-[var(--color-foreground-muted)]">连续失败 3 次后暂停该渠道 15 秒，防止雪崩。关闭后所有渠道始终可用。</p>
                </div>
                <Switch checked={circuitBreakerEnabled} onCheckedChange={setCircuitBreakerEnabled} />
              </div>
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
        </div>

        {oidcFeatureEnabled ? (
        <Card>
          <CardHeader>
            <SectionTitle
              title="OIDC 单点登录"
              description="配置通用 OIDC 提供商，支持用户通过第三方身份系统登录。"
            />
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--color-foreground)]">启用 OIDC 登录</p>
                <p className="text-xs text-[var(--color-foreground-muted)]">开启后登录页将显示 OIDC 登录按钮。</p>
              </div>
              <Switch checked={oidcEnabled} onCheckedChange={setOidcEnabled} />
            </div>
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
                    {(publicBaseUrl.replace(/\/+$/, "") || "https://your-domain.com") + "/api/auth/oidc/callback"}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const url = (publicBaseUrl.replace(/\/+$/, "") || window.location.origin) + "/api/auth/oidc/callback";
                      void navigator.clipboard.writeText(url).then(() => {
                        toast({ variant: "success", description: "已复制到剪贴板" });
                      });
                    }}
                  >
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
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--color-foreground)]">自动注册</p>
                <p className="text-xs text-[var(--color-foreground-muted)]">首次 OIDC 登录时自动创建用户。关闭后需先由管理员创建账号并绑定 OIDC。</p>
              </div>
              <Switch checked={oidcAutoRegister} onCheckedChange={setOidcAutoRegister} />
            </div>
          </CardContent>
        </Card>
        ) : null}

        {announcementFeatureEnabled ? (
        <Card>
          <CardHeader>
            <SectionTitle
              title="跨域访问 (CORS)"
              description="允许浏览器端从任意来源调用网关 API。开启后将对所有 /api/v1/* 接口返回 Access-Control-Allow-Origin: *。"
            />
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--color-foreground)]">允许所有来源跨域</p>
                <p className="text-xs text-[var(--color-foreground-muted)]">关闭时浏览器跨域请求会被拦截。仅在需要从前端直连网关时开启。</p>
              </div>
              <Switch checked={corsEnabled} onCheckedChange={setCorsEnabled} />
            </div>
          </CardContent>
        </Card>
        ) : null}

        {webhookFeatureEnabled ? (
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
                  {(publicBaseUrl.replace(/\/+$/, "") || "https://your-domain.com") + "/api/webhook"}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const url = (publicBaseUrl.replace(/\/+$/, "") || window.location.origin) + "/api/webhook";
                    void navigator.clipboard.writeText(url).then(() => {
                      toast({ variant: "success", description: "已复制到剪贴板" });
                    });
                  }}
                >
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
        ) : null}

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

        <Card>
          <CardContent className="flex items-center justify-end p-5">
            <Button onClick={save}>保存设置</Button>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
