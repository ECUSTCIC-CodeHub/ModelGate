import { randomBytes } from "node:crypto";
import { gatewayDb } from "@/lib/core/db";
import { toMysqlDatetime } from "@/lib/core/db/datetime";
import { generateGatewayKey } from "@/lib/auth/keys";

// ---------------------------------------------------------------------------
// DSH 接入：颁发一次性兑换码，DSH 用兑换码换网关密钥
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 5 * 60_000;
const MAX_PENDING_CODES_PER_USER = 5;
const KEY_LIMIT = 50;
const CODE_ATTEMPTS = 5;

/** 兑换码的状态全集。pending 与 delivered 都是「还能换一次」。 */
const LIVE_STATUSES = "('pending', 'delivered')";

export const DSH_KEY_NAME = "dsh";

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

export type DshEnrollment = {
  id: number;
  code: string;
  key: string;
  keyId: number;
  expiresAt: string;
  maskedKey: string;
};

export type EnrollFailure = "key_limit" | "enroll_limit" | "code_conflict";

export type EnrollResult = { ok: true; enrollment: DshEnrollment } | { ok: false; reason: EnrollFailure };

/** 生成 8 位 base32 兑换码（无分隔符，便于粘贴）。32 字符表整除 256，无模偏差。 */
function generateEnrollCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function computeExpiry(now: Date): string {
  return toMysqlDatetime(new Date(now.getTime() + CODE_TTL_MS));
}

// 靠 code 上的唯一键兜住极低概率的碰撞，不用先查后插（那是无锁的竞态）
async function pickCode(): Promise<string | null> {
  for (let attempts = 0; attempts < CODE_ATTEMPTS; attempts += 1) {
    const candidate = generateEnrollCode();
    const exists = await gatewayDb.queryOne<{ id: number }>(
      "SELECT id FROM dsh_enrollments WHERE code = ?",
      [candidate],
    );
    if (!exists) return candidate;
  }
  return null;
}

/**
 * 为用户新建一枚 DSH 专用密钥并颁发兑换码。
 *
 * 不复用用户已有密钥：那枚很可能正在网关里跑生产流量，把它投递到
 * 127.0.0.1 的任意端口等于用户不知情地把凭据交给了本机监听进程，
 * 而且之后无法单独吊销。每次授权新建，密钥名固定为 dsh，便于识别与删除。
 */
export async function enrollDsh(
  userId: number,
  options: { callbackUrl?: string | null; clientId?: string | null } = {},
): Promise<EnrollResult> {
  const keyCount = await gatewayDb.queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM `keys` WHERE user_id = ? AND deleted_at IS NULL",
    [userId],
  );
  if ((keyCount?.count ?? 0) >= KEY_LIMIT) return { ok: false, reason: "key_limit" };

  const pending = await gatewayDb.queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM dsh_enrollments WHERE user_id = ? AND status IN ${LIVE_STATUSES}`,
    [userId],
  );
  if ((pending?.count ?? 0) >= MAX_PENDING_CODES_PER_USER) return { ok: false, reason: "enroll_limit" };

  const code = await pickCode();
  if (!code) return { ok: false, reason: "code_conflict" };

  const now = new Date();
  const nowStr = toMysqlDatetime(now);
  const expiresAt = computeExpiry(now);
  const plaintextKey = generateGatewayKey();

  const inserted = await gatewayDb.transaction(async (tx) => {
    const keyResult = await tx.execute(
      "INSERT INTO `keys` (`key`, name, user_id, used_tokens, used_requests, enabled, created_at) VALUES (?, ?, ?, 0, 0, 1, ?)",
      [plaintextKey, DSH_KEY_NAME, userId, nowStr],
    );
    const keyId = keyResult.lastInsertRowid;
    const enrollResult = await tx.execute(
      `INSERT INTO dsh_enrollments (code, key_id, user_id, client_id, callback_url, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [code, keyId, userId, options.clientId ?? null, options.callbackUrl ?? null, nowStr, expiresAt],
    );
    return { id: enrollResult.lastInsertRowid, keyId };
  });

  return {
    ok: true,
    enrollment: {
      id: inserted.id,
      code,
      key: plaintextKey,
      keyId: inserted.keyId,
      expiresAt,
      maskedKey: maskKey(plaintextKey),
    },
  };
}

/**
 * 撤销一次尚未兑换的颁发：兑换码作废，刚建的密钥删掉。
 * 仅当兑换码仍是 pending 时才动密钥，避免和已经兑换的请求抢同一枚。
 */
export async function cancelEnrollment(enrollmentId: number, userId: number): Promise<void> {
  await gatewayDb.transaction(async (tx) => {
    const claimed = await tx.execute(
      "UPDATE dsh_enrollments SET status = 'revoked' WHERE id = ? AND user_id = ? AND status = 'pending'",
      [enrollmentId, userId],
    );
    if (claimed.changes !== 1) return;

    const row = await tx.queryOne<{ key_id: number }>(
      "SELECT key_id FROM dsh_enrollments WHERE id = ? AND user_id = ?",
      [enrollmentId, userId],
    );
    if (!row) return;
    await tx.execute(
      "DELETE FROM `keys` WHERE id = ? AND user_id = ? AND name = ?",
      [row.key_id, userId, DSH_KEY_NAME],
    );
  });
}

/** 只允许投递到本机 loopback，且不跟随重定向，避免本机进程把请求体（含明文密钥）转发出去。 */
function resolveLoopbackCallback(callbackUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return null;
  return url.toString();
}

/** 把兑换码投递到 DSH 本机回调。成功返回 true，失败返回 false（不抛错）。 */
export async function deliverToDsh(
  enrollmentId: number,
  callbackUrl: string,
  payload: { code: string; key: string; clientId?: string | null },
): Promise<boolean> {
  const target = resolveLoopbackCallback(callbackUrl);
  if (!target) return false;

  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: payload.code, key: payload.key, client_id: payload.clientId ?? null }),
      redirect: "manual",
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
 * 用兑换码换取网关密钥。兑换码一次性。
 *
 * 先把兑换码原子地占成 redeemed，只有 changes === 1 的那个请求能读到明文密钥，
 * 并发请求一律拿到「已被使用」。过期判断也放进 UPDATE 的 WHERE 里，
 * 用同一台应用时钟算出的字符串做比较，不依赖两套驱动的日期类型归一化行为。
 */
export async function redeemEnrollCode(
  code: string,
): Promise<{ ok: true; key: string; keyId: number } | { ok: false; reason: string }> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "兑换码不能为空" };

  const now = new Date();
  const nowStr = toMysqlDatetime(now);
  const claimed = await gatewayDb.execute(
    `UPDATE dsh_enrollments SET status = 'redeemed', redeemed_at = ?
     WHERE code = ? AND status IN ${LIVE_STATUSES} AND expires_at >= ?`,
    [nowStr, trimmed, nowStr],
  );

  const enrollment = await gatewayDb.queryOne<{ id: number; key_id: number; status: string }>(
    "SELECT id, key_id, status FROM dsh_enrollments WHERE code = ?",
    [trimmed],
  );
  if (!enrollment) return { ok: false, reason: "兑换码不存在" };

  if (claimed.changes !== 1) {
    if (enrollment.status === "pending" || enrollment.status === "delivered") {
      await gatewayDb.execute(
        `UPDATE dsh_enrollments SET status = 'expired' WHERE id = ? AND status IN ${LIVE_STATUSES}`,
        [enrollment.id],
      );
      return { ok: false, reason: "兑换码已过期" };
    }
    return { ok: false, reason: "兑换码已被使用" };
  }

  const keyRow = await gatewayDb.queryOne<{ key: string; enabled: number; deleted_at: string | null }>(
    "SELECT `key`, enabled, deleted_at FROM `keys` WHERE id = ?",
    [enrollment.key_id],
  );
  if (!keyRow || keyRow.deleted_at !== null || keyRow.enabled !== 1) {
    // 刚建的密钥被用户删了：这枚码已经没意义，删掉避免占着「待兑换」额度
    await gatewayDb.execute("DELETE FROM dsh_enrollments WHERE id = ?", [enrollment.id]);
    return { ok: false, reason: "密钥不可用，请重新授权" };
  }

  return { ok: true, key: keyRow.key, keyId: enrollment.key_id };
}

function maskKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 10)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`;
}
