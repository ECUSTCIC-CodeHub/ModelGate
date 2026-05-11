export const dynamic = "force-dynamic";

import { createHmac, timingSafeEqual } from "crypto";
import { gatewayDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { resolveGroupFromClaims } from "@/lib/oidc";
import { getGatewaySettings } from "@/lib/settings";

const MAX_TIMESTAMP_DRIFT = 300;

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

type RoleChangeData = {
  user_id: string;
  old_role: string;
  new_role: string;
};

type TagsChangedData = {
  user_id: string;
  action: string;
  tags: string[];
};

type IdentityChangeData = {
  user_id: string;
  field: string;
};

type WebhookPayload = {
  id: string;
  type: string;
  timestamp: string;
  app_id: string;
  data: RoleChangeData | TagsChangedData | IdentityChangeData;
};

function findUserByTdpId(tdpUserId: string) {
  return gatewayDb
    .prepare(
      "SELECT id, group_id FROM users WHERE oidc_subject = ? AND enabled = 1 AND deleted_at IS NULL",
    )
    .get(tdpUserId) as { id: number; group_id: number | null } | undefined;
}

function updateUserGroup(userId: number, groupId: number | null) {
  gatewayDb
    .prepare("UPDATE users SET group_id = ? WHERE id = ?")
    .run(groupId, userId);
}

function getDefaultGroupId(): number | null {
  const row = gatewayDb
    .prepare(
      "SELECT id FROM groups WHERE is_default = 1 AND enabled = 1 AND deleted_at IS NULL LIMIT 1",
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

function handleRoleChange(data: RoleChangeData): string {
  const user = findUserByTdpId(data.user_id);
  if (!user) return "用户不存在，已忽略";

  const claims = { role: data.new_role };
  const groupId = resolveGroupFromClaims(claims) ?? getDefaultGroupId();
  updateUserGroup(user.id, groupId);
  return `已将用户分组更新为 ${groupId ?? "默认"}`;
}

function handleTagsChanged(data: TagsChangedData): string {
  const user = findUserByTdpId(data.user_id);
  if (!user) return "用户不存在，已忽略";

  const claims = { tags: data.tags };
  const groupId = resolveGroupFromClaims(claims) ?? getDefaultGroupId();
  updateUserGroup(user.id, groupId);
  return `已将用户分组更新为 ${groupId ?? "默认"}`;
}

export async function POST(request: Request) {
  const settings = getGatewaySettings();
  if (!settings.tdp_webhook_secret) {
    return jsonError("Webhook 未配置密钥", 503);
  }

  const signature = request.headers.get("x-tdp-signature");
  const timestamp = request.headers.get("x-tdp-timestamp");
  const event = request.headers.get("x-tdp-event");

  if (!signature || !timestamp || !event) {
    return jsonError("缺少必要的请求头", 400);
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_DRIFT) {
    return jsonError("请求时间戳过期", 403);
  }

  const rawBody = await request.text();

  if (!verifySignature(rawBody, signature, settings.tdp_webhook_secret)) {
    return jsonError("签名验证失败", 403);
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonError("请求体格式错误", 400);
  }

  let result: string;
  switch (event) {
    case "user.role_change":
      result = handleRoleChange(payload.data as RoleChangeData);
      break;
    case "user.tags_changed":
      result = handleTagsChanged(payload.data as TagsChangedData);
      break;
    case "user.identity_change":
      result = `身份变更通知已接收 (field: ${(payload.data as IdentityChangeData).field})`;
      break;
    default:
      result = `未知事件类型: ${event}，已忽略`;
  }

  return jsonOk({ message: result, event_id: payload.id });
}
