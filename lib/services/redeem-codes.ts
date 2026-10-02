import { randomBytes } from "node:crypto";
import { gatewayDb } from "@/lib/core/db";
import type { ExecuteResult } from "@/lib/core/db/adapter";
import { toMysqlDatetime, parseStoredUtc } from "@/lib/core/db/datetime";
import { stringifyAllowedChannelIds } from "@/lib/gateway/channel-access";
import { stringifyAllowedModelAliases } from "@/lib/gateway/model-access";
import { buildRedeemScope, scopeCoversPair } from "@/lib/services/redeem-authorization";

// 判断是否为唯一约束冲突（SQLite: UNIQUE constraint failed; MySQL: ER_DUP_ENTRY）。
function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed|ER_DUP_ENTRY|duplicate entry/i.test(err.message ?? String(err));
}

// 用于在并发重复兑换时强制回滚事务，再由外层转为友好提示，避免多计一次核销次数。
class RedeemAlreadyRedeemedError extends Error {}

export type RedeemCodeRow = {
  id: number;
  code: string;
  batch_id: string;
  token_quota: number | null;
  request_quota: number | null;
  allowed_channel_ids: string;
  allowed_model_aliases: string;
  expires_at: string | null;
  enabled: number;
  max_uses: number;
  used_count: number;
  note: string | null;
  created_by: number | null;
  created_at: string;
};

export type RedeemBalanceRow = {
  id: number;
  code_id: number;
  user_id: number;
  token_quota: number | null;
  request_quota: number | null;
  used_tokens: number;
  used_requests: number;
  allowed_channel_ids: string;
  allowed_model_aliases: string;
  expires_at: string | null;
  created_at: string;
};

// 批量生成 N 个不重复兑换码，归入同一 batch_id。
export async function generateRedeemCodes(input: {
  count: number;
  tokenQuota: number | null;
  requestQuota: number | null;
  allowedChannelIds: number[];
  allowedModelAliases: string[];
  expiresAt: string | null;
  maxUses: number;
  note?: string;
  createdBy: number;
}): Promise<{ codes: string[]; batchId: string }> {
  const count = Math.min(500, Math.max(1, Math.floor(input.count)));
  const batchId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const now = toMysqlDatetime(new Date());

  const codes: string[] = [];
  await gatewayDb.transaction(async (tx) => {
    for (let i = 0; i < count; i += 1) {
      let code = "";
      let attempts = 0;
      // 生成去重兑换码，最多重试 5 次避免碰撞
      while (attempts < 5) {
        const candidate = generateRedeemCode();
        const exists = await tx.queryOne<{ id: number }>(
          "SELECT id FROM redeem_codes WHERE code = ?",
          [candidate],
        );
        if (!exists) {
          code = candidate;
          break;
        }
        attempts += 1;
      }
      if (!code) throw new Error("兑换码生成失败，请重试");

      await tx.execute(
        `INSERT INTO redeem_codes (
           code, batch_id, token_quota, request_quota,
           allowed_channel_ids, allowed_model_aliases,
           expires_at, enabled, max_uses, used_count, note, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`,
        [
          code,
          batchId,
          input.tokenQuota,
          input.requestQuota,
          stringifyAllowedChannelIds(input.allowedChannelIds),
          stringifyAllowedModelAliases(input.allowedModelAliases),
          input.expiresAt ?? null,
          input.maxUses,
          input.note?.trim() || null,
          input.createdBy,
          now,
        ],
      );
      codes.push(code);
    }
  });

  return { codes, batchId };
}

function generateRedeemCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = randomBytes(12);
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  // 格式：XXXX-XXXX-XXXX
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export function isCodeValid(row: Pick<RedeemCodeRow, "enabled" | "expires_at" | "max_uses" | "used_count">): { ok: boolean; reason?: string } {
  if (row.enabled !== 1) {
    return { ok: false, reason: "该兑换码已停用" };
  }
  if (row.max_uses !== 0 && row.used_count >= row.max_uses) {
    return { ok: false, reason: "该兑换码使用次数已达上限" };
  }
  if (row.expires_at) {
    const expires = parseStoredUtc(row.expires_at);
    if (expires && expires.getTime() <= Date.now()) {
      return { ok: false, reason: "该兑换码已过期" };
    }
  }
  return { ok: true };
}

export type RedeemCodeListRow = RedeemCodeRow & {
  created_by_username: string | null;
  redeemed_users: number;
  used_tokens_sum: number;
  used_requests_sum: number;
};

// 管理员列表用的聚合查询：LEFT JOIN 创建人用户名 + 聚合持有人数与已用额度。
// 用 GROUP BY rc.id 而不是 JOIN 后直接分页，避免一个码对应多条 balance 时把行数放大导致 total 失准。
// redeemed_users 的统计口径与 redeem-authorization 的行为保持一致：只数「当前仍有效」的额度，
// 已用尽/已过期/所属兑换码已停用的都不算，否则列表上会显示成还有人持有。
const CODE_LIST_SELECT = `SELECT rc.*,
         cu.username AS created_by_username,
         COUNT(CASE WHEN rc.enabled = 1
                      AND b.id IS NOT NULL
                      AND (b.expires_at IS NULL OR b.expires_at > ?)
                      AND (b.token_quota IS NULL OR b.used_tokens < b.token_quota)
                      AND (b.request_quota IS NULL OR b.used_requests < b.request_quota)
                    THEN 1 END) AS redeemed_users,
         COALESCE(SUM(b.used_tokens), 0) AS used_tokens_sum,
         COALESCE(SUM(b.used_requests), 0) AS used_requests_sum
    FROM redeem_codes rc
    LEFT JOIN users cu ON cu.id = rc.created_by
    LEFT JOIN redeem_balances b ON b.code_id = rc.id`;

export async function getCodeByCode(code: string): Promise<RedeemCodeRow | undefined> {
  return gatewayDb.queryOne<RedeemCodeRow>(
    "SELECT * FROM redeem_codes WHERE code = ?",
    [code.trim().toUpperCase()],
  );
}

export async function getCodeById(id: number): Promise<RedeemCodeRow | undefined> {
  return gatewayDb.queryOne<RedeemCodeRow>("SELECT * FROM redeem_codes WHERE id = ?", [id]);
}

// 批量启用/停用，返回实际影响行数（不存在的兑换码被忽略）。
export async function setRedeemCodesEnabled(codes: string[], enabled: boolean): Promise<number> {
  if (codes.length === 0) return 0;
  const placeholders = codes.map(() => "?").join(",");
  const result = await gatewayDb.execute(
    `UPDATE redeem_codes SET enabled = ? WHERE code IN (${placeholders})`,
    [enabled ? 1 : 0, ...codes],
  );
  return result.changes;
}

// 批量删除兑换码及其定向额度与核销记录，返回实际删除数量。
export async function deleteRedeemCodes(codes: string[]): Promise<number> {
  if (codes.length === 0) return 0;
  const placeholders = codes.map(() => "?").join(",");
  const ids = (await gatewayDb.query<{ id: number }>(
    `SELECT id FROM redeem_codes WHERE code IN (${placeholders})`,
    codes,
  )).map((row) => row.id);
  if (ids.length === 0) return 0;

  await gatewayDb.transaction(async (tx) => {
    const idPlaceholders = ids.map(() => "?").join(",");
    await tx.execute(`DELETE FROM redeem_redemptions WHERE code_id IN (${idPlaceholders})`, ids);
    await tx.execute(`DELETE FROM redeem_balances WHERE code_id IN (${idPlaceholders})`, ids);
    await tx.execute(`DELETE FROM redeem_codes WHERE id IN (${idPlaceholders})`, ids);
  });
  return ids.length;
}

// 用户兑换：校验有效性、限定渠道/模型是否存在，创建定向额度并登记核销。
export async function redeemCodeForUser(userId: number, code: string): Promise<{ ok: true; balance: RedeemBalanceRow } | { ok: false; reason: string }> {
  const normalized = code.trim().toUpperCase();
  const row = await getCodeByCode(normalized);
  if (!row) {
    return { ok: false, reason: "兑换码不存在" };
  }

  const validity = isCodeValid(row);
  if (!validity.ok) {
    return { ok: false, reason: validity.reason ?? "兑换码不可用" };
  }

  let result: { ok: false; reason: string } | { ok: true; balance: RedeemBalanceRow } | undefined;
  try {
    result = await gatewayDb.transaction(async (tx) => {
    const existing = await tx.queryOne<{ id: number }>(
      "SELECT id FROM redeem_balances WHERE code_id = ? AND user_id = ?",
      [row.id, userId],
    );
    if (existing) {
      return { ok: false as const, reason: "您已兑换过该兑换码" };
    }

    // 原子性核销：仅当 remaining uses 充足时才核销
    const updated = await tx.execute(
      `UPDATE redeem_codes
         SET used_count = used_count + 1
         WHERE id = ? AND enabled = 1
           AND (max_uses = 0 OR used_count < max_uses)
           AND (expires_at IS NULL OR expires_at > ?)`,
      [row.id, toMysqlDatetime(new Date())],
    );
    if (updated.changes !== 1) {
      return { ok: false as const, reason: "该兑换码已失效或使用次数已达上限" };
    }

    // 并发下同一用户重复兑换同一多用途兑换码时，SELECT 无法兜底，
    // 唯一约束会让后到事务抛错。捕获唯一约束冲突并转为友好提示。
    let balanceResult: ExecuteResult | undefined;
    try {
      balanceResult = await tx.execute(
        `INSERT INTO redeem_balances (
           code_id, user_id, token_quota, request_quota,
           allowed_channel_ids, allowed_model_aliases, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          userId,
          row.token_quota,
          row.request_quota,
          row.allowed_channel_ids,
          row.allowed_model_aliases,
          row.expires_at,
          toMysqlDatetime(new Date()),
        ],
      );
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // 抛出以回滚事务（回滚本次 used_count 自增），由外层捕获转为友好提示。
        throw new RedeemAlreadyRedeemedError();
      }
      throw err;
    }

    await tx.execute(
      `INSERT INTO redeem_redemptions (code_id, user_id) VALUES (?, ?)`,
      [row.id, userId],
    );

    const balance = await tx.queryOne<RedeemBalanceRow>(
      "SELECT * FROM redeem_balances WHERE id = ?",
      [balanceResult.lastInsertRowid],
    );
    return { ok: true as const, balance: balance! };
    });
  } catch (err) {
    if (err instanceof RedeemAlreadyRedeemedError) {
      return { ok: false as const, reason: "您已兑换过该兑换码" };
    }
    throw err;
  }

  return result;
}

// 查询用户所有有效的定向额度。
export async function listUserBalances(userId: number): Promise<Array<RedeemBalanceRow & { remaining_tokens: number | null; remaining_requests: number | null; active: boolean }>> {
  const rows = await gatewayDb.query<RedeemBalanceRow>(
    "SELECT * FROM redeem_balances WHERE user_id = ? ORDER BY id DESC",
    [userId],
  );
  return rows.map((row) => {
    const remainingTokens = row.token_quota !== null ? Math.max(0, row.token_quota - row.used_tokens) : null;
    const remainingRequests = row.request_quota !== null ? Math.max(0, row.request_quota - row.used_requests) : null;
    let active = true;
    if (row.expires_at) {
      const expires = parseStoredUtc(row.expires_at);
      if (expires && expires.getTime() <= Date.now()) active = false;
    }
    if (remainingTokens !== null && remainingTokens <= 0) active = false;
    if (remainingRequests !== null && remainingRequests <= 0) active = false;
    return {
      ...row,
      remaining_tokens: remainingTokens,
      remaining_requests: remainingRequests,
      active,
    };
  });
}

// 网关侧：查找匹配当前渠道+模型的用户有效定向额度。
// 与授权侧（redeem-authorization）共用同一有效性条件：兑换码启用、未过期、额度未耗尽，避免停用后计费仍命中。
export async function findMatchingRedeemBalance(userId: number, channelId: number | null, modelAlias: string | null): Promise<RedeemBalanceRow | null> {
  if (channelId === null || !modelAlias) return null;
  const now = toMysqlDatetime(new Date());
  const rows = await gatewayDb.query<RedeemBalanceRow>(
    `SELECT b.*
       FROM redeem_balances b
       JOIN redeem_codes c ON c.id = b.code_id
       WHERE b.user_id = ?
         AND c.enabled = 1
         AND (b.expires_at IS NULL OR b.expires_at > ?)
         AND (b.token_quota IS NULL OR b.used_tokens < b.token_quota)
         AND (b.request_quota IS NULL OR b.used_requests < b.request_quota)
       ORDER BY b.id`,
    [userId, now],
  );
  for (const row of rows) {
    // 与授权侧的配对判定共用同一份逻辑，避免两处规则漂移。
    if (scopeCoversPair(buildRedeemScope(row.allowed_channel_ids, row.allowed_model_aliases), channelId, modelAlias)) {
      return row;
    }
  }
  return null;
}

// 管理员：按批次查看兑换码列表，附带创建人、当前有效持有人数与已用额度聚合。
export async function listCodes(options: { keyword?: string; limit: number; offset: number; batchId?: string }) {
  const { keyword = "", limit, offset, batchId } = options;
  const whereParts: string[] = [];
  const args: Array<string | number> = [];
  if (keyword) {
    whereParts.push("rc.code LIKE ?");
    args.push(`%${keyword.toUpperCase()}%`);
  }
  if (batchId) {
    whereParts.push("rc.batch_id = ?");
    args.push(batchId);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const rows = await gatewayDb.query<RedeemCodeListRow>(
    `${CODE_LIST_SELECT} ${whereSql} GROUP BY rc.id ORDER BY rc.id DESC LIMIT ? OFFSET ?`,
    [toMysqlDatetime(new Date()), ...args, limit, offset],
  );
  const totalRow = await gatewayDb.queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM redeem_codes rc ${whereSql}`,
    args,
  );
  return {
    data: rows,
    total: totalRow?.total ?? 0,
  };
}

// 管理员：取单个兑换码的汇总详情（创建人 + 聚合用量）。
export async function getCodeDetail(id: number): Promise<RedeemCodeListRow | undefined> {
  return gatewayDb.queryOne<RedeemCodeListRow>(
    `${CODE_LIST_SELECT} WHERE rc.id = ? GROUP BY rc.id`,
    [toMysqlDatetime(new Date()), id],
  );
}

export type UpdateRedeemCodeInput = {
  note?: string | null;
  enabled?: boolean;
  expiresAt?: string | null;
  maxUses?: number;
  tokenQuota?: number | null;
  requestQuota?: number | null;
};

// 管理员编辑单个兑换码。遵循「只增不减」：额度类字段只允许上调，
// max_uses 只允许放宽（0 视为不限，属最宽），避免收紧后已兑换用户凭空失效。
// 有效期收紧时不得早于任一已发放额度的过期时间（NULL 表示长期有效，不能收紧为有限期）。
export async function updateRedeemCode(
  id: number,
  input: UpdateRedeemCodeInput,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await getCodeById(id);
  if (!row) return { ok: false, reason: "兑换码不存在" };

  const sets: string[] = [];
  const args: Array<string | number | null> = [];

  if (input.note !== undefined) {
    sets.push("note = ?");
    args.push(input.note === null ? null : input.note.trim() || null);
  }

  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(input.enabled ? 1 : 0);
  }

  if (input.maxUses !== undefined) {
    if (input.maxUses !== 0 && row.max_uses !== 0 && input.maxUses < row.max_uses) {
      return { ok: false, reason: "最多兑换次数只能放宽，不能收紧" };
    }
    if (input.maxUses !== 0 && input.maxUses < row.used_count) {
      return { ok: false, reason: `该兑换码已被兑换 ${row.used_count} 次，最多兑换次数不能小于该值` };
    }
    sets.push("max_uses = ?");
    args.push(input.maxUses);
  }

  if (input.tokenQuota !== undefined) {
    if (input.tokenQuota === null && row.token_quota !== null) {
      return { ok: false, reason: "Token 额度不能改为不限；如需放宽到不限请停用旧码并重新生成" };
    }
    if (input.tokenQuota !== null && row.token_quota !== null && input.tokenQuota < row.token_quota) {
      return { ok: false, reason: "Token 额度只能上调，不能下调；如需下调请停用旧码并重新生成" };
    }
    sets.push("token_quota = ?");
    args.push(input.tokenQuota);
  }

  if (input.requestQuota !== undefined) {
    if (input.requestQuota === null && row.request_quota !== null) {
      return { ok: false, reason: "请求额度不能改为不限；如需放宽到不限请停用旧码并重新生成" };
    }
    if (input.requestQuota !== null && row.request_quota !== null && input.requestQuota < row.request_quota) {
      return { ok: false, reason: "请求额度只能上调，不能下调；如需下调请停用旧码并重新生成" };
    }
    sets.push("request_quota = ?");
    args.push(input.requestQuota);
  }

  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null) {
      // NULL 会被核销 SQL 的 `expires_at IS NULL OR expires_at > ?` 豁免过期判定，
      // 允许改成 NULL 等于给该码开永久有效口子，故只允许延长、不允许清空。
      return { ok: false, reason: "有效期不能为空；如需永久有效请重新生成兑换码" };
    }
    const next = parseStoredUtc(input.expiresAt);
    if (!next) return { ok: false, reason: "有效期格式不正确" };
    const current = row.expires_at ? parseStoredUtc(row.expires_at) : null;
    if (current && next.getTime() < current.getTime()) {
      return { ok: false, reason: "有效期只能延长，不能缩短；如需缩短请停用该兑换码" };
    }
    // 所有已发放额度的过期时间都要放宽到新有效期之后：
    // 只看一条（LIMIT 1）会漏掉过期时间更晚的其他额度，导致它们凭空提前失效。
    const issued = await gatewayDb.query<{ expires_at: string | null }>(
      "SELECT expires_at FROM redeem_balances WHERE code_id = ?",
      [id],
    );
    if (issued.some((b) => !b.expires_at)) {
      return { ok: false, reason: "已有用户兑换该码且额度长期有效，无法为其设置有效期" };
    }
    for (const balance of issued) {
      const issuedExpires = balance.expires_at ? parseStoredUtc(balance.expires_at) : null;
      if (issuedExpires && next.getTime() < issuedExpires.getTime()) {
        return { ok: false, reason: "有效期不能早于已发放额度的过期时间" };
      }
    }
    sets.push("expires_at = ?");
    args.push(input.expiresAt);
  }

  if (sets.length === 0) return { ok: false, reason: "没有需要更新的字段" };

  // 原样应用到已发放额度：只放宽不收紧，不会让已兑换用户的余量变小。
  const balanceSets: string[] = [];
  const balanceArgs: Array<string | number | null> = [];
  if (input.tokenQuota !== undefined) {
    balanceSets.push("token_quota = ?");
    balanceArgs.push(input.tokenQuota);
  }
  if (input.requestQuota !== undefined) {
    balanceSets.push("request_quota = ?");
    balanceArgs.push(input.requestQuota);
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    balanceSets.push("expires_at = ?");
    balanceArgs.push(input.expiresAt);
  }

  await gatewayDb.transaction(async (tx) => {
    await tx.execute(`UPDATE redeem_codes SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
    if (balanceSets.length > 0) {
      await tx.execute(
        `UPDATE redeem_balances SET ${balanceSets.join(", ")} WHERE code_id = ?`,
        [...balanceArgs, id],
      );
    }
  });

  return { ok: true };
}

// 管理员：查看某批次的核销/兑换记录。
export async function listRedemptions(options: { codeId?: number; userId?: number; limit: number; offset: number }) {
  const { codeId, userId, limit, offset } = options;
  const whereParts: string[] = [];
  const args: Array<string | number> = [];
  if (codeId) {
    whereParts.push("r.code_id = ?");
    args.push(codeId);
  }
  if (userId) {
    whereParts.push("r.user_id = ?");
    args.push(userId);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const rows = await gatewayDb.query<Record<string, unknown>>(
    `SELECT r.id, r.code_id, r.user_id, r.redeemed_at, c.code, u.username,
            b.token_quota, b.request_quota, b.used_tokens, b.used_requests, b.expires_at
       FROM redeem_redemptions r
       LEFT JOIN redeem_codes c ON c.id = r.code_id
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN redeem_balances b ON b.code_id = r.code_id AND b.user_id = r.user_id
       ${whereSql}
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  const totalRow = await gatewayDb.queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM redeem_redemptions r ${whereSql}`,
    args,
  );
  return { data: rows, total: totalRow?.total ?? 0 };
}
