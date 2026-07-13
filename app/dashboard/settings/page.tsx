"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureAdmin } from "@/lib/auth/client-auth";
import { modelGateFeatures } from "@/lib/core/features";
import {
  AccessGuideNoticeSettingsCard,
  AnnouncementSettingsCard,
  AppearanceSettingsCard,
  CorsSettingsCard,
  EmailSettingsCard,
  FilingSettingsCard,
  FeedbackSettingsCard,
  LogRetentionSettingsCard,
  LoginSettingsCard,
  OidcSettingsCard,
  SaveSettingsCard,
  UaRestrictionsSettingsCard,
  UpstreamSettingsCard,
  WebhookSettingsCard,
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
      <div className="space-y-4 pb-6">
        <AppearanceSettingsCard
          themeColor={themeColor}
          setThemeColor={setThemeColor}
          logoUrl={logoUrl}
          setLogoUrl={setLogoUrl}
          logoSquareUrl={logoSquareUrl}
          setLogoSquareUrl={setLogoSquareUrl}
        />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <LoginSettingsCard
            oidcFeatureEnabled={oidcFeatureEnabled}
            passwordLoginEnabled={passwordLoginEnabled}
            registrationEnabled={registrationEnabled}
            setPasswordLoginEnabled={setPasswordLoginEnabled}
            setRegistrationEnabled={setRegistrationEnabled}
          />
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
        </div>

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

        <CorsSettingsCard corsEnabled={corsEnabled} setCorsEnabled={setCorsEnabled} />

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

        <LogRetentionSettingsCard days={logRetentionDays} setDays={setLogRetentionDays} />

        <SaveSettingsCard disabled={isSaving} onSave={() => void save()} />
      </div>
    </DashboardShell>
  );
}
