export type ModelGateEdition = "full" | "lite";

function normalizeEdition(value: string | undefined): ModelGateEdition {
  return value === "lite" ? "lite" : "full";
}

export const modelGateEdition = normalizeEdition(
  process.env.NEXT_PUBLIC_MODELGATE_EDITION ?? process.env.MODELGATE_EDITION,
);

export const modelGateFeatures = {
  oidc: modelGateEdition === "full",
  periodQuota: modelGateEdition === "full",
  announcement: modelGateEdition === "full",
  webhook: modelGateEdition === "full",
  accessGuideNotice: modelGateEdition === "full",
} as const;

export type ModelGateFeature = keyof typeof modelGateFeatures;

const featureNames: Record<ModelGateFeature, string> = {
  oidc: "OIDC",
  periodQuota: "周期配额",
  announcement: "公告",
  webhook: "Webhook",
  accessGuideNotice: "接入指南通知",
};

export function featureUnavailableMessage(featureName: string) {
  return `当前构建不包含${featureName}功能`;
}

export function isFeatureEnabled(feature: ModelGateFeature) {
  return modelGateFeatures[feature];
}

export function requireFeature(feature: ModelGateFeature, featureName = featureNames[feature]) {
  if (isFeatureEnabled(feature)) return null;
  return new Response(
    JSON.stringify({
      error: {
        message: featureUnavailableMessage(featureName),
        type: "not_found_error",
        param: "None",
        code: "404",
      },
    }),
    {
      status: 404,
      headers: { "content-type": "application/json" },
    },
  );
}

export type EditionSettingsInput = {
  password_login_enabled?: boolean;
  oidc_enabled?: boolean;
  oidc_issuer_url?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  oidc_scopes?: string;
  oidc_auto_register?: boolean;
  oidc_button_text?: string;
  announcement_content?: string;
  access_guide_notice?: string;
  webhook_secret?: string;
};

export function filterSettingsInputForEdition<T extends EditionSettingsInput>(input: T): T {
  const next = { ...input };
  if (!modelGateFeatures.oidc) {
    next.password_login_enabled = true;
    next.oidc_enabled = false;
    delete next.oidc_issuer_url;
    delete next.oidc_client_id;
    delete next.oidc_client_secret;
    delete next.oidc_scopes;
    delete next.oidc_auto_register;
    delete next.oidc_button_text;
  }
  if (!modelGateFeatures.announcement) {
    delete next.announcement_content;
  }
  if (!modelGateFeatures.webhook) {
    delete next.webhook_secret;
  }
  if (!modelGateFeatures.accessGuideNotice) {
    delete next.access_guide_notice;
  }
  return next;
}

export function maskSettingsForEdition<T extends {
  password_login_enabled: number;
  oidc_enabled: number;
  oidc_issuer_url: string;
  oidc_client_id: string;
  oidc_client_secret: string;
  oidc_scopes: string;
  oidc_auto_register: number;
  oidc_button_text: string;
  announcement_content: string;
  access_guide_notice: string;
  webhook_secret: string;
}>(settings: T): T {
  return {
    ...settings,
    password_login_enabled: modelGateFeatures.oidc ? settings.password_login_enabled : 1,
    oidc_enabled: modelGateFeatures.oidc ? settings.oidc_enabled : 0,
    oidc_issuer_url: modelGateFeatures.oidc ? settings.oidc_issuer_url : "",
    oidc_client_id: modelGateFeatures.oidc ? settings.oidc_client_id : "",
    oidc_client_secret: modelGateFeatures.oidc && settings.oidc_client_secret ? "••••••••" : "",
    oidc_scopes: modelGateFeatures.oidc ? settings.oidc_scopes : "openid profile email",
    oidc_auto_register: modelGateFeatures.oidc ? settings.oidc_auto_register : 1,
    oidc_button_text: modelGateFeatures.oidc ? settings.oidc_button_text : "OIDC 登录",
    announcement_content: modelGateFeatures.announcement ? settings.announcement_content : "",
    access_guide_notice: modelGateFeatures.accessGuideNotice ? settings.access_guide_notice : "",
    webhook_secret: modelGateFeatures.webhook && settings.webhook_secret ? "••••••••" : "",
  };
}
