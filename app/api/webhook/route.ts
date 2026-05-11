export const dynamic = "force-dynamic";

import { createHmac, timingSafeEqual } from "crypto";
import { gatewayDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { resolveGroupFromClaims } from "@/lib/oidc";
import { getGatewaySettings } from "@/lib/settings";

const MAX_TIMESTAMP_DRIFT = 300;

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function stripSignatureField(raw: string): string {
  const obj = JSON.parse(raw);
  delete obj.signature;
  return JSON.stringify(obj);
}

type RoleChangeData = {
  user_id: string;
  old_role: string;
  new_role: string;
};

type TagsChangedData = {
  user_id: string;
  action: "set" | "add" | "remove";
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
  signature: string;
  app_id?: string;
  data: RoleChangeData | TagsChangedData | IdentityChangeData;
};

type UserSnapshot = {
  id: number;
  group_id: number | null;
  webhook_role: string;
  webhook_tags: string;
};

function findUser(oidcSubject: string): UserSnapshot | undefined {
  return gatewayDb
    .prepare(
      "SELECT id, group_id, webhook_role, webhook_tags FROM users WHERE oidc_subject = ? AND enabled = 1 AND deleted_at IS NULL",
    )
    .get(oidcSubject) as UserSnapshot | undefined;
}

function getDefaultGroupId(): number | null {
  const row = gatewayDb
    .prepare(
      "SELECT id FROM groups WHERE is_default = 1 AND enabled = 1 AND deleted_at IS NULL LIMIT 1",
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

function resolveAndUpdate(userId: number, role: string, tags: string[]) {
  const claims: Record<string, unknown> = {};
  if (role) claims.role = role;
  if (tags.length) claims.tags = tags;

  const groupId = Object.keys(claims).length
    ? (resolveGroupFromClaims(claims) ?? getDefaultGroupId())
    : getDefaultGroupId();

  gatewayDb
    .prepare("UPDATE users SET webhook_role = ?, webhook_tags = ?, group_id = ? WHERE id = ?")
    .run(role, JSON.stringify(tags), groupId, userId);

  return groupId;
}

function parseTags(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function handleRoleChange(data: RoleChangeData): string {
  const user = findUser(data.user_id);
  if (!user) return "用户不存在，已忽略";

  const tags = parseTags(user.webhook_tags);
  const groupId = resolveAndUpdate(user.id, data.new_role, tags);
  return `已将用户分组更新为 ${groupId ?? "默认"}`;
}

function handleTagsChanged(data: TagsChangedData): string {
  const user = findUser(data.user_id);
  if (!user) return "用户不存在，已忽略";

  let tags: string[];
  const current = parseTags(user.webhook_tags);

  switch (data.action) {
    case "set":
      tags = data.tags;
      break;
    case "add":
      tags = [...new Set([...current, ...data.tags])];
      break;
    case "remove":
      tags = current.filter((t) => !data.tags.includes(t));
      break;
    default:
      tags = data.tags;
  }

  const groupId = resolveAndUpdate(user.id, user.webhook_role, tags);
  return `已将用户分组更新为 ${groupId ?? "默认"}`;
}

export async function POST(request: Request) {
  const settings = getGatewaySettings();
  if (!settings.webhook_secret) {
    return jsonError("Webhook 未配置密钥", 503);
  }

  const rawBody = await request.text();

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonError("请求体格式错误", 400);
  }

  if (!payload.signature || !payload.type || !payload.timestamp) {
    return jsonError("缺少 signature、type 或 timestamp 字段", 400);
  }

  const ts = Math.floor(new Date(payload.timestamp).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isNaN(ts) || Math.abs(now - ts) > MAX_TIMESTAMP_DRIFT) {
    return jsonError("请求时间戳过期", 403);
  }

  const unsigned = stripSignatureField(rawBody);
  if (!verifySignature(unsigned, payload.signature, settings.webhook_secret)) {
    return jsonError("签名验证失败", 403);
  }

  let result: string;
  switch (payload.type) {
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
      result = `未知事件类型: ${payload.type}，已忽略`;
  }

  return jsonOk({ message: result, event_id: payload.id });
}
