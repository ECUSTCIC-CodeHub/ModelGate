import { randomBytes } from "node:crypto";
import { gatewayDb } from "@/lib/core/db";
import { toMysqlDatetime, parseStoredUtc } from "@/lib/core/db/datetime";
import { generateGatewayKey } from "@/lib/auth/keys";

// ---------------------------------------------------------------------------
// DSH 接入：颁发一次性兑换码，DSH 用兑换码换网关密钥
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 5 * 60_000; // 兑换码 5 分钟有效

export type DshEnrollmentRow = {
  id: number;
  code: string;
  key_id: number;
  user_id: number;
  client_id: string | null;
  callback_url: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
};

/** 生成 8 位 base32 兑换码（无分隔符，便于粘贴）。 */
function generateEnrollCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** 计算兑换码过期时刻的 UTC 存储字符串。 */
function computeExpiry(now: Date = new Date()): string {
  return toMysqlDatetime(new Date(now.getTime() + CODE_TTL_MS));
}

/**
 * 为用户颁发一个 DSH 接入兑换码。
 * 复用一个已启用的网关密钥（reuse=true）或新建一个。
 * 返回兑换码与明文密钥——明文密钥只在此处和兑换时出现，不落库以外的地方。
 */
export async function enrollDsh(
  userId: number,
  options: { reuse?: boolean; callbackUrl?: string | null; clientId?: string | null } = {},
): Promise<{ code: string; key: string; keyId: number; expiresAt: string; maskedKey: string }> {
  const reuse = options.reuse !== false; // 默认复用
  const now = new Date();
  const expiresAt = computeExpiry(now);
  const nowStr = toMysqlDatetime(now);

  let keyId: number;
  let plaintextKey: string;

  await gatewayDb.transaction(async (tx) => {
    if (reuse) {
      // 复用用户最近创建的一个已启用密钥
      const existing = await tx.queryOne<{ id: number; key: string }>(
        `SELECT id, key FROM keys WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
        [userId],
      );
      if (existing) {
        keyId = existing.id;
        plaintextKey = existing.key;
        return;
      }
    }

    // 新建密钥
    plaintextKey = generateGatewayKey();
    const result = await tx.execute(
      `INSERT INTO keys (key, user_id, used_tokens, used_requests, enabled, created_at) VALUES (?, ?, 0, 0, 1, ?)`,
      [plaintextKey, userId, nowStr],
    );
    keyId = result.lastInsertRowid;
  });

  // 生成去重兑换码，最多重试 5 次
  let code = "";
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const candidate = generateEnrollCode();
    const exists = await gatewayDb.queryOne<{ id: number }>(
      "SELECT id FROM dsh_enrollments WHERE code = ?",
      [candidate],
    );
    if (!exists) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("兑换码生成失败，请重试");

  const insertResult = await gatewayDb.execute(
    `INSERT INTO dsh_enrollments (code, key_id, user_id, client_id, callback_url, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [code, keyId!, userId, options.clientId ?? null, options.callbackUrl ?? null, nowStr, expiresAt],
  );

  return {
    id: insertResult.lastInsertRowid,
    code,
    key: plaintextKey!,
    keyId: keyId!,
    expiresAt,
    maskedKey: maskKey(plaintextKey!),
  };
}

/** 尝试把密钥投递到 DSH 本机回调地址。成功返回 true，失败返回 false（不抛错）。 */
export async function deliverToDsh(
  enrollmentId: number,
  callbackUrl: string,
  payload: { code: string; key: string; clientId?: string | null },
): Promise<boolean> {
  try {
    const url = new URL(callbackUrl);
    // 只允许 http(s) 且只允许 localhost / 127.0.0.1 / ::1，防止 SSRF
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return false;

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: payload.code, key: payload.key, client_id: payload.clientId ?? null }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;

    await gatewayDb.execute(
      `UPDATE dsh_enrollments SET status = 'delivered' WHERE id = ? AND status = 'pending'`,
      [enrollmentId],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 用兑换码换取网关密钥。兑换码一次性，兑换后作废。
 * 返回明文密钥，或失败原因。
 */
export async function redeemEnrollCode(
  code: string,
): Promise<{ ok: true; key: string; keyId: number } | { ok: false; reason: string }> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "兑换码不能为空" };

  const enrollment = await gatewayDb.queryOne<DshEnrollmentRow>(
    "SELECT * FROM dsh_enrollments WHERE code = ?",
    [trimmed],
  );
  if (!enrollment) return { ok: false, reason: "兑换码不存在" };

  if (enrollment.status === "redeemed") return { ok: false, reason: "兑换码已被使用" };

  const expiresAt = parseStoredUtc(enrollment.expires_at);
  if (!expiresAt || expiresAt.getTime() < Date.now()) {
    await gatewayDb.execute(`UPDATE dsh_enrollments SET status = 'expired' WHERE id = ?`, [enrollment.id]);
    return { ok: false, reason: "兑换码已过期" };
  }

  // 取出明文密钥
  const keyRow = await gatewayDb.queryOne<{ key: string; enabled: number; deleted_at: string | null }>(
    "SELECT key, enabled, deleted_at FROM keys WHERE id = ?",
    [enrollment.key_id],
  );
  if (!keyRow || keyRow.deleted_at !== null || keyRow.enabled !== 1) {
    return { ok: false, reason: "密钥不可用，请重新颁发" };
  }

  // 标记为已兑换（一次性）
  await gatewayDb.execute(
    `UPDATE dsh_enrollments SET status = 'redeemed', redeemed_at = ? WHERE id = ? AND status != 'redeemed'`,
    [toMysqlDatetime(new Date()), enrollment.id],
  );

  return { ok: true, key: keyRow.key, keyId: enrollment.key_id };
}

function maskKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 10)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`;
}
