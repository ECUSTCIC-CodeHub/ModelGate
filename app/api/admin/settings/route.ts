export const dynamic = "force-dynamic";

import { z } from "zod";
import { filterSettingsInputForEdition, maskSettingsForEdition } from "@/lib/core/features";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { getGatewaySettings, setGatewaySettings } from "@/lib/core/settings";
import { validateUaRestrictionRules } from "@/lib/gateway/ua-restrictions";
import { parseModelBrandGroups } from "@/lib/core/settings";

const schema = z.object({
  registration_enabled: z.boolean(),
  password_login_enabled: z.boolean(),
  upstream_retry_enabled: z.boolean(),
  upstream_retry_max_attempts: z.number().int().min(1).max(10),
  upstream_retry_same_channel: z.boolean(),
  upstream_circuit_breaker_enabled: z.boolean(),
  upstream_strict_priority: z.boolean(),
  vision_fallback_enabled: z.boolean().optional(),
  vision_fallback_alias: z.string().max(255).optional(),
  model_fallback_enabled: z.boolean().optional(),
  model_fallback_alias: z.string().max(255).optional(),
  quota_fallback_enabled: z.boolean().optional(),
  quota_fallback_alias: z.string().max(255).optional(),
  oidc_enabled: z.boolean().optional(),
  oidc_issuer_url: z.string().optional(),
  oidc_client_id: z.string().optional(),
  oidc_client_secret: z.string().optional(),
  oidc_scopes: z.string().optional(),
  oidc_auto_register: z.boolean().optional(),
  oidc_button_text: z.string().optional(),
  oidc_group_expire_days: z.number().int().min(0).max(3650).optional(),
  public_base_url: z.string().optional(),
  announcement_content: z.string().max(5000).optional(),
  announcement_display_count: z.number().int().min(1).max(20).optional(),
  access_guide_notice: z.string().max(10000).optional(),
  webhook_secret: z.string().max(200).optional(),
  cors_enabled: z.boolean().optional(),
  icp_filing_number: z.string().max(200).optional(),
  public_security_filing_number: z.string().max(200).optional(),
  ua_restrictions: z.string().max(20000).optional(),
  log_retention_days: z.number().int().min(0).max(3650).optional(),
  theme_color: z.string().regex(/^(|#[0-9a-fA-F]{6})$/, "主题色格式不正确").optional(),
  logo_url: z.string().max(2000).optional(),
  logo_square_url: z.string().max(2000).optional(),
  feedback_url: z
    .string()
    .max(2000)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "反馈链接必须以 http(s):// 开头")
    .optional(),
  repo_name: z.string().max(200).optional(),
  model_status_light_1_hours: z.number().int().min(1).max(168).optional(),
  model_status_light_2_hours: z.number().int().min(1).max(168).optional(),
  model_status_light_3_hours: z.number().int().min(1).max(168).optional(),
  top_users_visible: z.boolean().optional(),
  overview_global: z.boolean().optional(),
  default_model_is_public: z.boolean().optional(),
  model_brand_groups: z.string().max(20000).optional(),
  default_appearance: z.enum(["default", "retro"]).optional(),
  default_mode: z.enum(["light", "dark", "system"]).optional(),
});

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const settings = await getGatewaySettings();
  return jsonOk({ message: "系统设置获取成功。", data: maskSettingsForEdition(settings) });
}

export async function PUT(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  if (parsed.data.ua_restrictions !== undefined) {
    const validation = validateUaRestrictionRules(parsed.data.ua_restrictions);
    if (!validation.valid) return jsonError(validation.error, 400);
  }

  if (parsed.data.model_brand_groups !== undefined) {
    let rawGroups: unknown;
    try {
      rawGroups = JSON.parse(parsed.data.model_brand_groups);
    } catch {
      return jsonError("模型品牌分组格式不正确", 400);
    }
    if (!Array.isArray(rawGroups)) return jsonError("模型品牌分组必须为数组", 400);
    for (const item of rawGroups) {
      if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).label !== "string" || typeof (item as Record<string, unknown>).pattern !== "string") {
        return jsonError("每条品牌组需包含 label 与 pattern", 400);
      }
      if ((item as { label: string }).label.length > 50 || (item as { pattern: string }).pattern.length > 100) {
        return jsonError("品牌名最长 50 字符，前缀规则最长 100 字符", 400);
      }
    }
    const normalized = parseModelBrandGroups(parsed.data.model_brand_groups);
    if (normalized.length !== rawGroups.length) {
      return jsonError("品牌组的品牌名与前缀规则不能为空", 400);
    }
  }

  const input = filterSettingsInputForEdition({ ...parsed.data });
  if (input.oidc_client_secret === "••••••••") {
    delete input.oidc_client_secret;
  }
  if (input.webhook_secret === "••••••••") {
    delete input.webhook_secret;
  }

  const oidcWillBeEnabled = input.oidc_enabled !== undefined
    ? input.oidc_enabled && !!input.oidc_issuer_url && !!input.oidc_client_id
    : (await getGatewaySettings()).oidc_enabled === 1;

  if (!input.password_login_enabled && !oidcWillBeEnabled) {
    return jsonError("账号密码登录和 OIDC 登录不能同时关闭，至少保留一种登录方式。", 400);
  }

  await setGatewaySettings(input);

  const updated = await getGatewaySettings();
  return jsonOk({
    message: "系统设置更新成功。",
    data: maskSettingsForEdition(updated),
  });
}
