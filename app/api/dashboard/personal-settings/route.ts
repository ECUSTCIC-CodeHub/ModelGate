export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { getGatewaySettings } from "@/lib/core/settings";

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user as DbUser;
  const settings = await getGatewaySettings();

  return jsonOk({
    preferences: {
      model_fallback: user.pref_model_fallback,
      vision_fallback: user.pref_vision_fallback,
      quota_fallback: user.pref_quota_fallback,
    },
    defaults: {
      model_fallback: settings.model_fallback_enabled === 1,
      vision_fallback: settings.vision_fallback_enabled === 1,
      quota_fallback: settings.quota_fallback_enabled === 1,
    },
  });
}

const triState = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

const schema = z.object({
  model_fallback: triState.optional(),
  vision_fallback: triState.optional(),
  quota_fallback: triState.optional(),
});

export async function PUT(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const sets: string[] = [];
  const params: number[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    sets.push(`pref_${key} = ?`);
    params.push(value as number);
  }
  if (sets.length === 0) {
    return jsonOk({ message: "个人设置未变更。" });
  }

  params.push(guard.auth.user.id);
  await gatewayDb.execute(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`,
    params,
  );

  return jsonOk({ message: "个人设置已保存。" });
}
