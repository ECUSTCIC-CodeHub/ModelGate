export const dynamic = "force-dynamic";

import { createHmac, timingSafeEqual } from "crypto";
import { gatewayDb } from "@/lib/core/db";
import { requireFeature } from "@/lib/core/features";
import { jsonError, jsonOk } from "@/lib/core/http";
import { resolveGroupFromClaims } from "@/lib/auth/oidc";
import { getGatewaySettings } from "@/lib/core/settings";
import { forgetWebhookEvent, isWebhookEventDuplicate } from "@/lib/services/webhook-dedup";
import { API_BODY_LIMIT_BYTES, readBodyCapped } from "@/lib/core/request-body";

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

type StatusChangeData = {
  user_id: string;
  new_status: "blocked" | "active";
};

type WebhookPayload = {
  id: string;
  type: string;
  timestamp: string;
  signature: string;
  app_id?: string;
  data: RoleChangeData | TagsChangedData | IdentityChangeData | StatusChangeData;
};

type UserSnapshot = {
  id: number;
  group_id: number | null;
  enabled: number;
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

// 故意不过滤 enabled：禁用用户仍需被后续 Webhook 定位，否则解封事件永远找不到人，
// 用户会被永久锁在禁用状态（身份源已放行但网关仍拒绝）
async function findUser(oidcSubject: string): Promise<UserSnapshot | undefined> {
  return gatewayDb.queryOne<UserSnapshot>(
    "SELECT id, group_id, enabled, webhook_role, webhook_tags FROM users WHERE oidc_subject = ? AND deleted_at IS NULL",
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

async function handleRoleChange(data: RoleChangeData): Promise<string> {
  const user = await findUser(data.user_id);
  if (!user) return "用户不存在，已忽略";
  // 禁用用户的角色/标签变更不再改写分组：状态由身份源掌握，等解封事件恢复。
  // （不改写也拿不到权限，因为鉴权强制 enabled = 1，此处仅收敛语义）
  if (user.enabled !== 1) return "用户已被禁用，已忽略本次角色变更";

  const tags = parseTags(user.webhook_tags);
  const groupId = await resolveAndUpdate(user.id, data.new_role, tags);
  return `已将用户分组更新为 ${groupId ?? "默认"}`;
}

async function handleTagsChanged(data: TagsChangedData): Promise<string> {
  const user = await findUser(data.user_id);
  if (!user) return "用户不存在，已忽略";
  if (user.enabled !== 1) return "用户已被禁用，已忽略本次标签变更";

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

async function handleStatusChange(data: StatusChangeData): Promise<string> {
  if (data.new_status !== "blocked" && data.new_status !== "active") {
    return `未知的用户状态: ${String(data.new_status)}，已忽略`;
  }

  const user = await findUser(data.user_id);
  if (!user) return "用户不存在，已忽略";

  const enabled = data.new_status === "active" ? 1 : 0;
  if (user.enabled === enabled) {
    return `用户已是${enabled ? "启用" : "禁用"}状态，无需变更`;
  }

  await gatewayDb.execute("UPDATE users SET enabled = ? WHERE id = ?", [enabled, user.id]);
  return enabled ? "已启用用户" : "已禁用用户";
}

export async function POST(request: Request) {
  const unavailable = requireFeature("webhook");
  if (unavailable) return unavailable;

  const settings = await getGatewaySettings();
  if (!settings.webhook_secret) {
    return jsonError("Webhook 未配置密钥", 503);
  }

  const rawResult = await readBodyCapped(request, API_BODY_LIMIT_BYTES);
  if (!rawResult.ok) {
    return rawResult.reason === "too_large"
      ? jsonError("请求体过大", 413)
      : jsonError("请求体读取失败", 400);
  }
  const rawBytes = rawResult.bytes;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return jsonError("请求体格式错误", 400);
  }
  if (typeof parsedBody !== "object" || parsedBody === null) {
    return jsonError("请求体格式错误", 400);
  }
  const payload = parsedBody as WebhookPayload;

  if (
    typeof payload.id !== "string" ||
    typeof payload.signature !== "string" ||
    typeof payload.type !== "string" ||
    typeof payload.timestamp !== "string" ||
    (payload.app_id !== undefined && typeof payload.app_id !== "string") ||
    typeof payload.data !== "object" ||
    payload.data === null ||
    !payload.id ||
    !payload.signature ||
    !payload.type ||
    !payload.timestamp
  ) {
    return jsonError("缺少 id、signature、type、timestamp 或 data 字段", 400);
  }

  const ts = Math.floor(new Date(payload.timestamp).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isNaN(ts) || Math.abs(now - ts) > MAX_TIMESTAMP_DRIFT) {
    return jsonError("请求时间戳过期", 403);
  }

  if (!verifySignature(settings.webhook_secret, payload)) {
    return jsonError("签名验证失败", 403);
  }

  // app_id 校验必须早于去重：来源不匹配时事件被忽略，若先占用去重标记，
  // 配置修好后用同一 id 重试会被当成重复投递而不再生效。
  if (!(await isTrustedAppId(payload.app_id))) {
    return jsonOk({ message: APP_ID_MISMATCH_MESSAGE, event_id: payload.id });
  }

  if (isWebhookEventDuplicate(payload.id)) {
    return jsonOk({ message: "重复的事件已处理，已忽略。", event_id: payload.id });
  }

  let result: string;
  try {
    switch (payload.type) {
      case "user.role_change":
        result = await handleRoleChange(payload.data as RoleChangeData);
        break;
      case "user.tags_changed":
        result = await handleTagsChanged(payload.data as TagsChangedData);
        break;
      case "user.identity_change":
        result = `身份变更通知已接收 (field: ${(payload.data as IdentityChangeData).field})`;
        break;
      case "user.status_change":
        result = await handleStatusChange(payload.data as StatusChangeData);
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
