export const dynamic = "force-dynamic";

import { createHmac, timingSafeEqual } from "crypto";
import { gatewayDb } from "@/lib/core/db";
import { requireFeature } from "@/lib/core/features";
import { jsonError, jsonOk } from "@/lib/core/http";
import { resolveGroupFromClaims } from "@/lib/auth/oidc";
import { getGatewaySettings } from "@/lib/core/settings";
import { forgetWebhookEvent, isWebhookEventDuplicate } from "@/lib/services/webhook-dedup";

const MAX_TIMESTAMP_DRIFT = 300;

function computeSignature(
  secret: string,
  id: string,
  type: string,
  timestamp: string,
  appId: string | null,
  data: unknown,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(id + "." + type + "." + timestamp);
  if (appId !== null) mac.update("." + appId);
  mac.update(JSON.stringify(data));
  return "sha256=" + mac.digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function verifySignature(secret: string, payload: WebhookPayload): boolean {
  if (safeEqual(computeSignature(secret, payload.id, payload.type, payload.timestamp, null, payload.data), payload.signature)) {
    return true;
  }
  if (!payload.app_id) return false;
  return safeEqual(
    computeSignature(secret, payload.id, payload.type, payload.timestamp, payload.app_id, payload.data),
    payload.signature,
  );
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

const APP_ID_MISMATCH_MESSAGE = "app_id 与当前 OIDC 客户端不匹配，已忽略";

async function isTrustedAppId(appId: string | undefined): Promise<boolean> {
  const trimmed = (appId ?? "").trim();
  if (!trimmed) return true;
  const settings = await getGatewaySettings();
  return trimmed === (settings.oidc_client_id ?? "").trim();
}

async function findUser(oidcSubject: string): Promise<UserSnapshot | undefined> {
  return gatewayDb.queryOne<UserSnapshot>(
    "SELECT id, group_id, webhook_role, webhook_tags FROM users WHERE oidc_subject = ? AND enabled = 1 AND deleted_at IS NULL",
    [oidcSubject],
  );
}

async function getDefaultGroupId(): Promise<number | null> {
  const row = await gatewayDb.queryOne<{ id: number }>(
    "SELECT id FROM `groups` WHERE is_default = 1 AND enabled = 1 AND deleted_at IS NULL LIMIT 1",
  );
  return row?.id ?? null;
}

async function resolveAndUpdate(userId: number, role: string, tags: string[]) {
  const claims: Record<string, unknown> = {};
  if (role) claims.role = role;
  if (tags.length) claims.tags = tags;

  const groupId = Object.keys(claims).length
    ? ((await resolveGroupFromClaims(claims)) ?? (await getDefaultGroupId()))
    : await getDefaultGroupId();

  await gatewayDb.execute(
    "UPDATE users SET webhook_role = ?, webhook_tags = ?, group_id = ? WHERE id = ?",
    [role, JSON.stringify(tags), groupId, userId],
  );

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

async function handleRoleChange(data: RoleChangeData, appId: string | undefined): Promise<string> {
  if (!(await isTrustedAppId(appId))) return APP_ID_MISMATCH_MESSAGE;
  const user = await findUser(data.user_id);
  if (!user) return "用户不存在，已忽略";

  const tags = parseTags(user.webhook_tags);
  const groupId = await resolveAndUpdate(user.id, data.new_role, tags);
  return `已将用户分组更新为 ${groupId ?? "默认"}`;
}

async function handleTagsChanged(data: TagsChangedData, appId: string | undefined): Promise<string> {
  if (!(await isTrustedAppId(appId))) return APP_ID_MISMATCH_MESSAGE;
  const user = await findUser(data.user_id);
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

  const groupId = await resolveAndUpdate(user.id, user.webhook_role, tags);
  return `已将用户分组更新为 ${groupId ?? "默认"}`;
}

export async function POST(request: Request) {
  const unavailable = requireFeature("webhook");
  if (unavailable) return unavailable;

  const settings = await getGatewaySettings();
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

  if (!verifySignature(settings.webhook_secret, payload)) {
    return jsonError("签名验证失败", 403);
  }

  if (isWebhookEventDuplicate(payload.id)) {
    return jsonOk({ message: "重复的事件已处理，已忽略。", event_id: payload.id });
  }

  let result: string;
  try {
    switch (payload.type) {
      case "user.role_change":
        result = await handleRoleChange(payload.data as RoleChangeData, payload.app_id);
        break;
      case "user.tags_changed":
        result = await handleTagsChanged(payload.data as TagsChangedData, payload.app_id);
        break;
      case "user.identity_change":
        result = `身份变更通知已接收 (field: ${(payload.data as IdentityChangeData).field})`;
        break;
      default:
        result = `未知事件类型: ${payload.type}，已忽略`;
    }
  } catch {
    forgetWebhookEvent(payload.id);
    return jsonError("处理 Webhook 失败", 500);
  }

  return jsonOk({ message: result, event_id: payload.id });
}
