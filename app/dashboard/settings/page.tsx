"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useToast } from "@/components/ui/toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { clampStatusLightHours } from "@/lib/shared/utils";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureAdmin } from "@/lib/auth/client-auth";
import { modelGateFeatures } from "@/lib/core/features";
import {
  AccessGuideNoticeSettingsCard,
  AnnouncementSettingsCard,
  AppearanceSettingsCard,
  BroadcastEmailCard,
  CorsSettingsCard,
  EmailSettingsCard,
  FilingSettingsCard,
  FeedbackSettingsCard,
  LogRetentionSettingsCard,
  LoginSettingsCard,
  ModelStatusLightSettingsCard,
  OidcSettingsCard,
  SaveSettingsCard,
  UaRestrictionsSettingsCard,
  UpstreamSettingsCard,
  VisionFallbackSettingsCard,
  ModelFallbackSettingsCard,
  QuotaFallbackSettingsCard,
  ModelDefaultVisibilitySettingsCard,
  ModelBrandGroupsSettingsCard,
  WebhookSettingsCard,
  TopUsersVisibilitySettingsCard,
  OverviewScopeSettingsCard,
} from "./settings-cards";

function responseData(payload: unknown) {
  if (!payload || typeof payload !== "object") return {};
  const data = (payload as { data?: unknown }).data;
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("appearance");
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true);
  const [upstreamRetryEnabled, setUpstreamRetryEnabled] = useState(true);
  const [upstreamRetryMaxAttempts, setUpstreamRetryMaxAttempts] = useState(3);
  const [upstreamRetrySameChannel, setUpstreamRetrySameChannel] = useState(false);
  const [circuitBreakerEnabled, setCircuitBreakerEnabled] = useState(true);
  const [upstreamStrictPriority, setUpstreamStrictPriority] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcIssuerUrl, setOidcIssuerUrl] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcScopes, setOidcScopes] = useState("openid profile email");
  const [oidcAutoRegister, setOidcAutoRegister] = useState(true);
  const [oidcButtonText, setOidcButtonText] = useState("OIDC 登录");
  const [oidcGroupExpireDays, setOidcGroupExpireDays] = useState(30);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [announcementContent, setAnnouncementContent] = useState("");
  const [announcementDisplayCount, setAnnouncementDisplayCount] = useState(3);
  const [accessGuideNotice, setAccessGuideNotice] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [corsEnabled, setCorsEnabled] = useState(false);
  const [icpFilingNumber, setIcpFilingNumber] = useState("");
  const [publicSecurityFilingNumber, setPublicSecurityFilingNumber] = useState("");
  const [themeColor, setThemeColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoSquareUrl, setLogoSquareUrl] = useState("");
  const [feedbackUrl, setFeedbackUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [uaRestrictions, setUaRestrictions] = useState("");
  const [logRetentionDays, setLogRetentionDays] = useState(0);
  const [statusLight1Hours, setStatusLight1Hours] = useState(1);
  const [statusLight2Hours, setStatusLight2Hours] = useState(2);
  const [statusLight3Hours, setStatusLight3Hours] = useState(3);
  const [topUsersVisible, setTopUsersVisible] = useState(true);
  const [overviewGlobal, setOverviewGlobal] = useState(true);
  const [visionFallbackEnabled, setVisionFallbackEnabled] = useState(false);
  const [visionFallbackAlias, setVisionFallbackAlias] = useState("");
  const [modelFallbackEnabled, setModelFallbackEnabled] = useState(false);
  const [modelFallbackAlias, setModelFallbackAlias] = useState("");
  const [quotaFallbackEnabled, setQuotaFallbackEnabled] = useState(false);
  const [quotaFallbackAlias, setQuotaFallbackAlias] = useState("");
  const [defaultModelIsPublic, setDefaultModelIsPublic] = useState(true);
  const [modelBrandGroups, setModelBrandGroups] = useState("");
  const [defaultAppearance, setDefaultAppearance] = useState<"default" | "retro">("default");
  const [defaultMode, setDefaultMode] = useState<"light" | "dark" | "system">("system");
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();
  const oidcFeatureEnabled = modelGateFeatures.oidc;
  const announcementFeatureEnabled = modelGateFeatures.announcement;
  const accessGuideNoticeFeatureEnabled = modelGateFeatures.accessGuideNotice;
  const webhookFeatureEnabled = modelGateFeatures.webhook;
  const uaRestrictionsFeatureEnabled = modelGateFeatures.uaRestrictions;

  const applySettings = useCallback((settings: Record<string, unknown>) => {
    setRegistrationEnabled(settings.registration_enabled === 1);
    setPasswordLoginEnabled(settings.password_login_enabled !== 0);
    setUpstreamRetryEnabled(settings.upstream_retry_enabled !== 0);
    setUpstreamRetryMaxAttempts(Number(settings.upstream_retry_max_attempts ?? 3));
    setUpstreamRetrySameChannel(settings.upstream_retry_same_channel === 1);
    setCircuitBreakerEnabled(settings.upstream_circuit_breaker_enabled !== 0);
    setUpstreamStrictPriority(settings.upstream_strict_priority === 1);
    if (oidcFeatureEnabled) {
      setOidcEnabled(settings.oidc_enabled === 1);
      setOidcIssuerUrl(stringValue(settings.oidc_issuer_url));
      setOidcClientId(stringValue(settings.oidc_client_id));
      setOidcClientSecret(stringValue(settings.oidc_client_secret));
      setOidcScopes(stringValue(settings.oidc_scopes, "openid profile email"));
      setOidcAutoRegister(settings.oidc_auto_register !== 0);
      setOidcButtonText(stringValue(settings.oidc_button_text, "OIDC 登录"));
      const expireRaw = Number(settings.oidc_group_expire_days);
      setOidcGroupExpireDays(Number.isFinite(expireRaw) && expireRaw >= 0 ? Math.min(Math.trunc(expireRaw), 3650) : 30);
    }

    const savedBase = stringValue(settings.public_base_url);
    setPublicBaseUrl(savedBase || (typeof window !== "undefined" ? window.location.origin : ""));
    if (announcementFeatureEnabled) setAnnouncementContent(stringValue(settings.announcement_content));
    if (announcementFeatureEnabled) setAnnouncementDisplayCount(Number(settings.announcement_display_count ?? 3));
    if (accessGuideNoticeFeatureEnabled) setAccessGuideNotice(stringValue(settings.access_guide_notice));
    if (webhookFeatureEnabled) setWebhookSecret(stringValue(settings.webhook_secret));
    if (uaRestrictionsFeatureEnabled) setUaRestrictions(stringValue(settings.ua_restrictions));
    const retentionRaw = Number(settings.log_retention_days);
    setLogRetentionDays(Number.isFinite(retentionRaw) && retentionRaw >= 0 ? Math.min(Math.trunc(retentionRaw), 3650) : 0);
    setCorsEnabled(settings.cors_enabled === 1);
    setIcpFilingNumber(stringValue(settings.icp_filing_number));
    setPublicSecurityFilingNumber(stringValue(settings.public_security_filing_number));
    setThemeColor(stringValue(settings.theme_color));
    setLogoUrl(stringValue(settings.logo_url));
    setLogoSquareUrl(stringValue(settings.logo_square_url));
    setFeedbackUrl(stringValue(settings.feedback_url));
    setRepoName(stringValue(settings.repo_name));
    setStatusLight1Hours(clampStatusLightHours(settings.model_status_light_1_hours, 1));
    setStatusLight2Hours(clampStatusLightHours(settings.model_status_light_2_hours, 2));
    setStatusLight3Hours(clampStatusLightHours(settings.model_status_light_3_hours, 3));
    setTopUsersVisible(settings.top_users_visible !== 0);
    setOverviewGlobal(settings.overview_global !== 0);
    setVisionFallbackEnabled(settings.vision_fallback_enabled === 1);
    setVisionFallbackAlias(stringValue(settings.vision_fallback_alias));
    setModelFallbackEnabled(settings.model_fallback_enabled === 1);
    setModelFallbackAlias(stringValue(settings.model_fallback_alias));
    setQuotaFallbackEnabled(settings.quota_fallback_enabled === 1);
    setQuotaFallbackAlias(stringValue(settings.quota_fallback_alias));
    setDefaultModelIsPublic(settings.default_model_is_public !== 0);
    setModelBrandGroups(stringValue(settings.model_brand_groups));
    const da = stringValue(settings.default_appearance);
    setDefaultAppearance(da === "retro" ? "retro" : "default");
    const dm = stringValue(settings.default_mode);
    if (dm === "dark" || dm === "system") {
      setDefaultMode(dm);
    } else {
      setDefaultMode("light");
    }
  }, [accessGuideNoticeFeatureEnabled, announcementFeatureEnabled, oidcFeatureEnabled, webhookFeatureEnabled, uaRestrictionsFeatureEnabled]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!(await ensureAdmin(router)) || cancelled) return;
      const response = await authedFetch("/api/admin/settings");
      const payload = await response.json().catch(() => null);
      if (!cancelled && response.ok) {
        applySettings(responseData(payload));
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [applySettings, router]);

  async function save() {
    setIsSaving(true);
    try {
      const payload = {
        registration_enabled: registrationEnabled,
        password_login_enabled: passwordLoginEnabled,
        upstream_retry_enabled: upstreamRetryEnabled,
        upstream_retry_max_attempts: upstreamRetryMaxAttempts,
        upstream_retry_same_channel: upstreamRetrySameChannel,
        upstream_circuit_breaker_enabled: circuitBreakerEnabled,
        upstream_strict_priority: upstreamStrictPriority,
        ...(oidcFeatureEnabled ? {
          oidc_enabled: oidcEnabled,
          oidc_issuer_url: oidcIssuerUrl,
          oidc_client_id: oidcClientId,
          oidc_client_secret: oidcClientSecret,
          oidc_scopes: oidcScopes,
          oidc_auto_register: oidcAutoRegister,
          oidc_button_text: oidcButtonText,
          oidc_group_expire_days: oidcGroupExpireDays,
        } : {}),
        public_base_url: publicBaseUrl,
        ...(announcementFeatureEnabled ? { announcement_content: announcementContent } : {}),
        ...(announcementFeatureEnabled ? { announcement_display_count: announcementDisplayCount } : {}),
        ...(accessGuideNoticeFeatureEnabled ? { access_guide_notice: accessGuideNotice } : {}),
        ...(webhookFeatureEnabled ? { webhook_secret: webhookSecret } : {}),
        ...(uaRestrictionsFeatureEnabled ? { ua_restrictions: uaRestrictions } : {}),
        log_retention_days: logRetentionDays,
        cors_enabled: corsEnabled,
        icp_filing_number: icpFilingNumber,
        public_security_filing_number: publicSecurityFilingNumber,
        theme_color: themeColor,
        logo_url: logoUrl,
        logo_square_url: logoSquareUrl,
        feedback_url: feedbackUrl,
        repo_name: repoName,
        model_status_light_1_hours: statusLight1Hours,
        model_status_light_2_hours: statusLight2Hours,
        model_status_light_3_hours: statusLight3Hours,
        top_users_visible: topUsersVisible,
        overview_global: overviewGlobal,
        vision_fallback_enabled: visionFallbackEnabled,
        vision_fallback_alias: visionFallbackAlias,
        model_fallback_enabled: modelFallbackEnabled,
        model_fallback_alias: modelFallbackAlias,
        quota_fallback_enabled: quotaFallbackEnabled,
        quota_fallback_alias: quotaFallbackAlias,
        default_model_is_public: defaultModelIsPublic,
        model_brand_groups: modelBrandGroups,
        default_appearance: defaultAppearance,
        default_mode: defaultMode,
      };

      const response = await authedFetch("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "保存成功。") });
        applySettings(responseData(data));
        router.refresh();
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "保存失败。") });
    } finally {
      setIsSaving(false);
    }
  }

  function copyPublicUrl(path: string) {
    const base = publicBaseUrl.replace(/\/+$/, "") || (typeof window !== "undefined" ? window.location.origin : "");
    void navigator.clipboard.writeText(base + path).then(() => {
      toast({ variant: "success", description: "已复制到剪贴板" });
    });
  }

  return (
    <DashboardShell
      role="admin"
      title="系统设置"
      subtitle={oidcFeatureEnabled ? "配置登录注册策略、上游重试与 OIDC 单点登录。" : "配置登录注册策略与上游重试。"}
    >
      <Tabs value={activeTab} onValueChange={setActiveTab} className="pb-6">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList className="w-max gap-1">
            <TabsTrigger value="appearance">外观</TabsTrigger>
            <TabsTrigger value="auth">认证与安全</TabsTrigger>
            <TabsTrigger value="gateway">网关与上游</TabsTrigger>
            <TabsTrigger value="content">内容与通知</TabsTrigger>
            <TabsTrigger value="site">站点信息</TabsTrigger>
            <TabsTrigger value="system">系统维护</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="appearance" className="space-y-4">
          <AppearanceSettingsCard
            themeColor={themeColor}
            setThemeColor={setThemeColor}
            logoUrl={logoUrl}
            setLogoUrl={setLogoUrl}
            logoSquareUrl={logoSquareUrl}
            setLogoSquareUrl={setLogoSquareUrl}
            defaultAppearance={defaultAppearance}
            setDefaultAppearance={setDefaultAppearance}
            defaultMode={defaultMode}
            setDefaultMode={setDefaultMode}
          />
        </TabsContent>

        <TabsContent value="auth" className="space-y-4">
          <LoginSettingsCard
            oidcFeatureEnabled={oidcFeatureEnabled}
            passwordLoginEnabled={passwordLoginEnabled}
            registrationEnabled={registrationEnabled}
            setPasswordLoginEnabled={setPasswordLoginEnabled}
            setRegistrationEnabled={setRegistrationEnabled}
          />
          {oidcFeatureEnabled ? (
            <OidcSettingsCard
              oidcEnabled={oidcEnabled}
              oidcIssuerUrl={oidcIssuerUrl}
              oidcClientId={oidcClientId}
              oidcClientSecret={oidcClientSecret}
              oidcScopes={oidcScopes}
              oidcAutoRegister={oidcAutoRegister}
              oidcButtonText={oidcButtonText}
              oidcGroupExpireDays={oidcGroupExpireDays}
              publicBaseUrl={publicBaseUrl}
              setOidcEnabled={setOidcEnabled}
              setOidcIssuerUrl={setOidcIssuerUrl}
              setOidcClientId={setOidcClientId}
              setOidcClientSecret={setOidcClientSecret}
              setOidcScopes={setOidcScopes}
              setOidcAutoRegister={setOidcAutoRegister}
              setOidcButtonText={setOidcButtonText}
              setOidcGroupExpireDays={setOidcGroupExpireDays}
              setPublicBaseUrl={setPublicBaseUrl}
              copyPublicUrl={copyPublicUrl}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="gateway" className="space-y-4">
          <UpstreamSettingsCard
            upstreamRetryEnabled={upstreamRetryEnabled}
            upstreamRetryMaxAttempts={upstreamRetryMaxAttempts}
            upstreamRetrySameChannel={upstreamRetrySameChannel}
            circuitBreakerEnabled={circuitBreakerEnabled}
            upstreamStrictPriority={upstreamStrictPriority}
            setUpstreamRetryEnabled={setUpstreamRetryEnabled}
            setUpstreamRetryMaxAttempts={setUpstreamRetryMaxAttempts}
            setUpstreamRetrySameChannel={setUpstreamRetrySameChannel}
            setCircuitBreakerEnabled={setCircuitBreakerEnabled}
            setUpstreamStrictPriority={setUpstreamStrictPriority}
          />
          <CorsSettingsCard corsEnabled={corsEnabled} setCorsEnabled={setCorsEnabled} />
          <VisionFallbackSettingsCard
            visionFallbackEnabled={visionFallbackEnabled}
            visionFallbackAlias={visionFallbackAlias}
            setVisionFallbackEnabled={setVisionFallbackEnabled}
            setVisionFallbackAlias={setVisionFallbackAlias}
          />
          <ModelFallbackSettingsCard
            modelFallbackEnabled={modelFallbackEnabled}
            modelFallbackAlias={modelFallbackAlias}
            setModelFallbackEnabled={setModelFallbackEnabled}
            setModelFallbackAlias={setModelFallbackAlias}
          />
          <QuotaFallbackSettingsCard
            quotaFallbackEnabled={quotaFallbackEnabled}
            quotaFallbackAlias={quotaFallbackAlias}
            setQuotaFallbackEnabled={setQuotaFallbackEnabled}
            setQuotaFallbackAlias={setQuotaFallbackAlias}
          />
          <ModelDefaultVisibilitySettingsCard
            defaultModelIsPublic={defaultModelIsPublic}
            setDefaultModelIsPublic={setDefaultModelIsPublic}
          />
          <ModelBrandGroupsSettingsCard
            value={modelBrandGroups}
            onChange={setModelBrandGroups}
          />
          <ModelStatusLightSettingsCard
            hours1={statusLight1Hours}
            setHours1={setStatusLight1Hours}
            hours2={statusLight2Hours}
            setHours2={setStatusLight2Hours}
            hours3={statusLight3Hours}
            setHours3={setStatusLight3Hours}
          />
          {uaRestrictionsFeatureEnabled ? (
            <UaRestrictionsSettingsCard
              value={uaRestrictions}
              onChange={setUaRestrictions}
            />
          ) : null}
          {webhookFeatureEnabled ? (
            <WebhookSettingsCard
              publicBaseUrl={publicBaseUrl}
              webhookSecret={webhookSecret}
              setWebhookSecret={setWebhookSecret}
              copyPublicUrl={copyPublicUrl}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="content" className="space-y-4">
          {announcementFeatureEnabled ? (
            <AnnouncementSettingsCard
              announcementDisplayCount={announcementDisplayCount}
              setAnnouncementDisplayCount={setAnnouncementDisplayCount}
            />
          ) : null}
          {accessGuideNoticeFeatureEnabled ? (
            <AccessGuideNoticeSettingsCard
              accessGuideNotice={accessGuideNotice}
              setAccessGuideNotice={setAccessGuideNotice}
            />
          ) : null}
          {announcementFeatureEnabled ? <EmailSettingsCard /> : null}
          {announcementFeatureEnabled ? <BroadcastEmailCard /> : null}
          <TopUsersVisibilitySettingsCard
            topUsersVisible={topUsersVisible}
            setTopUsersVisible={setTopUsersVisible}
          />
          <OverviewScopeSettingsCard
            overviewGlobal={overviewGlobal}
            setOverviewGlobal={setOverviewGlobal}
          />
        </TabsContent>

        <TabsContent value="site" className="space-y-4">
          <FilingSettingsCard
            icpFilingNumber={icpFilingNumber}
            publicSecurityFilingNumber={publicSecurityFilingNumber}
            setIcpFilingNumber={setIcpFilingNumber}
            setPublicSecurityFilingNumber={setPublicSecurityFilingNumber}
          />
          <FeedbackSettingsCard
            feedbackUrl={feedbackUrl}
            repoName={repoName}
            setFeedbackUrl={setFeedbackUrl}
            setRepoName={setRepoName}
          />
        </TabsContent>

        <TabsContent value="system" className="space-y-4">
          <LogRetentionSettingsCard days={logRetentionDays} setDays={setLogRetentionDays} />
        </TabsContent>

        <div className="pt-2">
          <SaveSettingsCard disabled={isSaving} onSave={() => void save()} />
        </div>
      </Tabs>
    </DashboardShell>
  );
}
