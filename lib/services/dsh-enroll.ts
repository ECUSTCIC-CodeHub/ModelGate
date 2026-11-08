import { randomBytes } from "node:crypto";
import { gatewayDb } from "@/lib/core/db";
import { toMysqlDatetime } from "@/lib/core/db/datetime";
import { generateGatewayKey } from "@/lib/auth/keys";

// ---------------------------------------------------------------------------
// DSH 接入：颁发一次性兑换码，DSH 用兑换码换网关密钥
//
// 全程走 OAuth 授权码模式：服务端只发兑换码，明文密钥由 DSH 自己调
// /api/user/dsh/redeem 取回。服务端不主动 POST 明文密钥到本机端口——
// 那既不在插件契约里，也会让一次投递失败连累刚建好的密钥。
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 5 * 60_000;
const MAX_PENDING_CODES_PER_USER = 5;
const KEY_LIMIT = 50;
const CODE_ATTEMPTS = 5;

/** 兑换码的状态全集。pending 是唯一还能换一次的状态，其余都是终态。 */
const PENDING_STATUS = "pending";

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
 * 不复用用户已有密钥：那枚很可能正在网关里跑生产流量，把它交给 DSH 等于
 * 用户不知情地多了一处凭据副本，而且之后无法单独吊销。每次授权新建，
 * 密钥名固定为 dsh，便于识别与删除。
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

  // 只算还没过期的：过期但状态仍是 pending 的记录要等清理任务才翻牌，
  // 不排除的话用户会被这些死码卡在「待兑换过多」上最多一个清理周期。
  const pending = await gatewayDb.queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM dsh_enrollments WHERE user_id = ? AND status = ? AND expires_at >= ?",
    [userId, PENDING_STATUS, toMysqlDatetime(new Date())],
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code,
        keyId,
        userId,
        options.clientId ?? null,
        options.callbackUrl ?? null,
        PENDING_STATUS,
        nowStr,
        expiresAt,
      ],
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
      "UPDATE dsh_enrollments SET status = 'revoked' WHERE id = ? AND user_id = ? AND status = ?",
      [enrollmentId, userId, PENDING_STATUS],
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

/**
 * 用兑换码换取网关密钥。兑换码一次性。
 *
 * 先把兑换码原子地占成 redeemed，只有 changes === 1 的那个请求能读到明文密钥，
 * 并发请求一律拿到「已被使用」。过期判断也放进 UPDATE 的 WHERE 里，
 * 用同一台应用时钟算出的字符串做比较，不依赖两套驱动的日期类型归一化行为。
 *
 * expectedUserId 用于绑定授权会话：传入时只接受该用户颁发的码，
 * 防止别人拿自己机器上的插件把受害者的密钥换走。
 */
export async function redeemEnrollCode(
  code: string,
  expectedUserId?: number | null,
): Promise<{ ok: true; key: string; keyId: number } | { ok: false; reason: string }> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "兑换码不能为空" };

  const enrollment = await gatewayDb.queryOne<{ id: number; key_id: number; user_id: number; status: string }>(
    "SELECT id, key_id, user_id, status FROM dsh_enrollments WHERE code = ?",
    [trimmed],
  );
  if (!enrollment) return { ok: false, reason: "兑换码不存在" };

  if (expectedUserId != null && enrollment.user_id !== expectedUserId) {
    return { ok: false, reason: "兑换码不属于当前账号" };
  }

  const nowStr = toMysqlDatetime(new Date());
  const claimed = await gatewayDb.execute(
    `UPDATE dsh_enrollments SET status = 'redeemed', redeemed_at = ?
     WHERE id = ? AND status = ? AND expires_at >= ?`,
    [nowStr, enrollment.id, PENDING_STATUS, nowStr],
  );

  if (claimed.changes !== 1) {
    if (enrollment.status === PENDING_STATUS) return { ok: false, reason: "兑换码已过期" };
    return { ok: false, reason: "兑换码已被使用" };
  }

  const keyRow = await gatewayDb.queryOne<{ key: string; enabled: number; deleted_at: string | null }>(
    "SELECT `key`, enabled, deleted_at FROM `keys` WHERE id = ? AND user_id = ?",
    [enrollment.key_id, enrollment.user_id],
  );
  if (!keyRow || keyRow.deleted_at !== null || keyRow.enabled !== 1) {
    // 刚建的密钥被用户删了：这枚码已经没意义，删掉避免占着待兑换额度
    await gatewayDb.execute("DELETE FROM dsh_enrollments WHERE id = ?", [enrollment.id]);
    return { ok: false, reason: "密钥不可用，请重新授权" };
  }

  return { ok: true, key: keyRow.key, keyId: enrollment.key_id };
}

function maskKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 10)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`;
}
