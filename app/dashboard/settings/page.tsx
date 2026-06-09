"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch, ensureAdmin } from "@/lib/auth/client-auth";
import { modelGateFeatures } from "@/lib/core/features";
import {
  AnnouncementSettingsCard,
  CorsSettingsCard,
  FilingSettingsCard,
  LoginSettingsCard,
  OidcSettingsCard,
  SaveSettingsCard,
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
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcIssuerUrl, setOidcIssuerUrl] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcScopes, setOidcScopes] = useState("openid profile email");
  const [oidcAutoRegister, setOidcAutoRegister] = useState(true);
  const [oidcButtonText, setOidcButtonText] = useState("OIDC 登录");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [announcementContent, setAnnouncementContent] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [corsEnabled, setCorsEnabled] = useState(false);
  const [icpFilingNumber, setIcpFilingNumber] = useState("");
  const [publicSecurityFilingNumber, setPublicSecurityFilingNumber] = useState("");
  const { toast } = useToast();
  const oidcFeatureEnabled = modelGateFeatures.oidc;
  const announcementFeatureEnabled = modelGateFeatures.announcement;
  const webhookFeatureEnabled = modelGateFeatures.webhook;

  const applySettings = useCallback((settings: Record<string, unknown>) => {
    setRegistrationEnabled(settings.registration_enabled === 1);
    setPasswordLoginEnabled(settings.password_login_enabled !== 0);
    setUpstreamRetryEnabled(settings.upstream_retry_enabled !== 0);
    setUpstreamRetryMaxAttempts(Number(settings.upstream_retry_max_attempts ?? 3));
    setUpstreamRetrySameChannel(settings.upstream_retry_same_channel === 1);
    setCircuitBreakerEnabled(settings.upstream_circuit_breaker_enabled !== 0);
    if (oidcFeatureEnabled) {
      setOidcEnabled(settings.oidc_enabled === 1);
      setOidcIssuerUrl(stringValue(settings.oidc_issuer_url));
      setOidcClientId(stringValue(settings.oidc_client_id));
      setOidcClientSecret(stringValue(settings.oidc_client_secret));
      setOidcScopes(stringValue(settings.oidc_scopes, "openid profile email"));
      setOidcAutoRegister(settings.oidc_auto_register !== 0);
      setOidcButtonText(stringValue(settings.oidc_button_text, "OIDC 登录"));
    }

    const savedBase = stringValue(settings.public_base_url);
    setPublicBaseUrl(savedBase || (typeof window !== "undefined" ? window.location.origin : ""));
    if (announcementFeatureEnabled) setAnnouncementContent(stringValue(settings.announcement_content));
    if (webhookFeatureEnabled) setWebhookSecret(stringValue(settings.webhook_secret));
    setCorsEnabled(settings.cors_enabled === 1);
    setIcpFilingNumber(stringValue(settings.icp_filing_number));
    setPublicSecurityFilingNumber(stringValue(settings.public_security_filing_number));
  }, [announcementFeatureEnabled, oidcFeatureEnabled, webhookFeatureEnabled]);

  const load = useCallback(async () => {
    if (!(await ensureAdmin(router))) return;
    const response = await authedFetch("/api/admin/settings");
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      applySettings(responseData(payload));
    }
  }, [applySettings, router]);

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
    const payload = {
      registration_enabled: registrationEnabled,
      password_login_enabled: passwordLoginEnabled,
      upstream_retry_enabled: upstreamRetryEnabled,
      upstream_retry_max_attempts: upstreamRetryMaxAttempts,
      upstream_retry_same_channel: upstreamRetrySameChannel,
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
      ...(webhookFeatureEnabled ? { webhook_secret: webhookSecret } : {}),
      cors_enabled: corsEnabled,
      icp_filing_number: icpFilingNumber,
      public_security_filing_number: publicSecurityFilingNumber,
    };

    const response = await authedFetch("/api/admin/settings", {
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
            setUpstreamRetryEnabled={setUpstreamRetryEnabled}
            setUpstreamRetryMaxAttempts={setUpstreamRetryMaxAttempts}
            setUpstreamRetrySameChannel={setUpstreamRetrySameChannel}
            setCircuitBreakerEnabled={setCircuitBreakerEnabled}
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
            publicBaseUrl={publicBaseUrl}
            setOidcEnabled={setOidcEnabled}
            setOidcIssuerUrl={setOidcIssuerUrl}
            setOidcClientId={setOidcClientId}
            setOidcClientSecret={setOidcClientSecret}
            setOidcScopes={setOidcScopes}
            setOidcAutoRegister={setOidcAutoRegister}
            setOidcButtonText={setOidcButtonText}
            setPublicBaseUrl={setPublicBaseUrl}
            copyPublicUrl={copyPublicUrl}
          />
        ) : null}

        <CorsSettingsCard corsEnabled={corsEnabled} setCorsEnabled={setCorsEnabled} />

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
            announcementContent={announcementContent}
            setAnnouncementContent={setAnnouncementContent}
          />
        ) : null}

        <FilingSettingsCard
          icpFilingNumber={icpFilingNumber}
          publicSecurityFilingNumber={publicSecurityFilingNumber}
          setIcpFilingNumber={setIcpFilingNumber}
          setPublicSecurityFilingNumber={setPublicSecurityFilingNumber}
        />

        <SaveSettingsCard onSave={() => void save()} />
      </div>
    </DashboardShell>
  );
}
