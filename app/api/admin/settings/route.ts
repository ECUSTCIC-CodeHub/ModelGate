export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { getGatewaySettings, setGatewaySettings } from "@/lib/settings";

const schema = z.object({
  registration_enabled: z.boolean(),
  password_login_enabled: z.boolean(),
  upstream_retry_enabled: z.boolean(),
  upstream_retry_max_attempts: z.number().int().min(1).max(10),
  upstream_circuit_breaker_enabled: z.boolean(),
  oidc_enabled: z.boolean().optional(),
  oidc_issuer_url: z.string().optional(),
  oidc_client_id: z.string().optional(),
  oidc_client_secret: z.string().optional(),
  oidc_scopes: z.string().optional(),
  oidc_auto_register: z.boolean().optional(),
  oidc_button_text: z.string().optional(),
  oidc_group_claim: z.string().optional(),
  public_base_url: z.string().optional(),
  announcement_content: z.string().max(5000).optional(),
});

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const settings = getGatewaySettings();
  const masked = {
    ...settings,
    oidc_client_secret: settings.oidc_client_secret ? "••••••••" : "",
  };
  return jsonOk({ message: "系统设置获取成功。", data: masked });
}

export async function PUT(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const input = { ...parsed.data };
  if (input.oidc_client_secret === "••••••••") {
    delete input.oidc_client_secret;
  }

  const oidcWillBeEnabled = input.oidc_enabled !== undefined
    ? input.oidc_enabled && !!input.oidc_issuer_url && !!input.oidc_client_id
    : getGatewaySettings().oidc_enabled === 1;

  if (!input.password_login_enabled && !oidcWillBeEnabled) {
    return jsonError("账号密码登录和 OIDC 登录不能同时关闭，至少保留一种登录方式。", 400);
  }

  setGatewaySettings(input);

  const updated = getGatewaySettings();
  return jsonOk({
    message: "系统设置更新成功。",
    data: { ...updated, oidc_client_secret: updated.oidc_client_secret ? "••••••••" : "" },
  });
}
