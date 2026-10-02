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
  uaRestrictions: modelGateEdition === "full",
  redeemCode: modelGateEdition === "full",
} as const;

export type ModelGateFeature = keyof typeof modelGateFeatures;

// 可运行时开关的功能：构建版本为 full 时默认开启，管理员可在系统设置中关闭。
const runtimeToggleableFeatures: ModelGateFeature[] = ["redeemCode"];

export const runtimeFeatureDefaults: Record<string, boolean> = Object.fromEntries(
  runtimeToggleableFeatures.map((feature) => [feature, modelGateFeatures[feature]]),
);

export function isRuntimeToggleableFeature(feature: ModelGateFeature): boolean {
  return runtimeToggleableFeatures.includes(feature);
}

// 运行时功能开关（合并管理员设置）。
// 语义是「只能收窄，不能放宽」：构建版本不含该功能时，settings 里残留的 "1" 不得把它放出来，
// 否则精简版切到完整版再切回去，就会凭一行历史设置复活一个本该不存在的接口。
export function resolveRuntimeFeatures(settings: Record<string, unknown>): Record<ModelGateFeature, boolean> {
  const merged = { ...modelGateFeatures } as Record<ModelGateFeature, boolean>;
  for (const feature of runtimeToggleableFeatures) {
    const buildDefault = modelGateFeatures[feature];
    if (!buildDefault) {
      merged[feature] = false;
      continue;
    }
    const raw = settings[featureSettingsKey(feature)];
    if (raw === 0 || raw === "0") merged[feature] = false;
  }
  return merged;
}

export function featureSettingsKey(feature: ModelGateFeature): string {
  return `feature_${feature}_enabled`;
}

// 兑换码接口的统一守卫：构建版本不含该功能、或管理员在系统设置中关闭时，均返回 404。
export function requireRedeemCodeFeature(settings: { runtime_features: Record<string, boolean> }) {
  return requireRuntimeFeature(settings.runtime_features.redeemCode === true, featureNames.redeemCode);
}

const featureNames: Record<ModelGateFeature, string> = {
  oidc: "OIDC",
  periodQuota: "周期配额",
  announcement: "公告",
  webhook: "Webhook",
  accessGuideNotice: "接入指南通知",
  uaRestrictions: "User-Agent 限制",
  redeemCode: "兑换码",
};

export function featureUnavailableMessage(featureName: string) {
  return `当前构建不包含${featureName}功能`;
}

export function isFeatureEnabled(feature: ModelGateFeature) {
  return modelGateFeatures[feature];
}

export function requireFeature(feature: ModelGateFeature, featureName = featureNames[feature]) {
  return requireRuntimeFeature(modelGateFeatures[feature], featureName);
}

// 与 requireFeature 同语义，但接受已解析的运行时开关值，供需要合并管理员设置的调用方使用。
export function requireRuntimeFeature(enabled: boolean, featureName: string) {
  if (enabled) return null;
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
  oidc_group_expire_days?: number;
  public_base_url?: string;
  announcement_content?: string;
  announcement_display_count?: number;
  access_guide_notice?: string;
  webhook_secret?: string;
  ua_restrictions?: string;
  theme_color?: string;
  logo_url?: string;
  logo_square_url?: string;
  model_brand_groups?: string;
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
    delete next.oidc_group_expire_days;
  }
  if (!modelGateFeatures.announcement) {
    delete next.announcement_content;
    delete next.announcement_display_count;
  }
  if (!modelGateFeatures.webhook) {
    delete next.webhook_secret;
  }
  if (!modelGateFeatures.accessGuideNotice) {
    delete next.access_guide_notice;
  }
  if (!modelGateFeatures.uaRestrictions) {
    delete next.ua_restrictions;
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
  announcement_display_count: number;
  access_guide_notice: string;
  webhook_secret: string;
  ua_restrictions: string;
  theme_color: string;
  logo_url: string;
  logo_square_url: string;
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
    announcement_display_count: modelGateFeatures.announcement ? settings.announcement_display_count : 3,
    access_guide_notice: modelGateFeatures.accessGuideNotice ? settings.access_guide_notice : "",
    webhook_secret: modelGateFeatures.webhook && settings.webhook_secret ? "••••••••" : "",
    ua_restrictions: modelGateFeatures.uaRestrictions ? settings.ua_restrictions : "",
    theme_color: settings.theme_color,
  };
}
