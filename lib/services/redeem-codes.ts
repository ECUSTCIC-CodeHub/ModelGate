import { randomBytes } from "node:crypto";
import { gatewayDb } from "@/lib/core/db";
import { toMysqlDatetime, parseStoredUtc } from "@/lib/core/db/datetime";
import { parseAllowedChannelIds, stringifyAllowedChannelIds } from "@/lib/gateway/channel-access";
import { parseAllowedModelAliases, stringifyAllowedModelAliases } from "@/lib/gateway/model-access";

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

export async function getCodeByCode(code: string): Promise<RedeemCodeRow | undefined> {
  return gatewayDb.queryOne<RedeemCodeRow>(
    "SELECT * FROM redeem_codes WHERE code = ?",
    [code.trim().toUpperCase()],
  );
}

export async function getCodeById(id: number): Promise<RedeemCodeRow | undefined> {
  return gatewayDb.queryOne<RedeemCodeRow>("SELECT * FROM redeem_codes WHERE id = ?", [id]);
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

  const result = await gatewayDb.transaction(async (tx) => {
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

    const balanceResult = await tx.execute(
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
export async function findMatchingRedeemBalance(userId: number, channelId: number | null, modelAlias: string | null): Promise<RedeemBalanceRow | null> {
  if (channelId === null || !modelAlias) return null;
  const rows = await gatewayDb.query<RedeemBalanceRow>(
    `SELECT * FROM redeem_balances WHERE user_id = ? ORDER BY id`,
    [userId],
  );
  for (const row of rows) {
    // 校验有效期与额度
    const remainingTokens = row.token_quota !== null ? row.token_quota - row.used_tokens : null;
    const remainingRequests = row.request_quota !== null ? row.request_quota - row.used_requests : null;
    if (remainingTokens !== null && remainingTokens <= 0) continue;
    if (remainingRequests !== null && remainingRequests <= 0) continue;
    if (row.expires_at) {
      const expires = parseStoredUtc(row.expires_at);
      if (expires && expires.getTime() <= Date.now()) continue;
    }
    const channelIds = parseAllowedChannelIds(row.allowed_channel_ids);
    const aliases = parseAllowedModelAliases(row.allowed_model_aliases);
    const channelMatch = channelIds.length === 0 || channelIds.includes(channelId);
    const aliasMatch = aliases.length === 0 || aliases.includes(modelAlias);
    if (channelMatch && aliasMatch) {
      return row;
    }
  }
  return null;
}

// 管理员：按批次查看兑换码列表。
export async function listCodes(options: { keyword?: string; limit: number; offset: number; batchId?: string }) {
  const { keyword = "", limit, offset, batchId } = options;
  const whereParts: string[] = [];
  const args: Array<string | number> = [];
  if (keyword) {
    whereParts.push("code LIKE ?");
    args.push(`%${keyword.toUpperCase()}%`);
  }
  if (batchId) {
    whereParts.push("batch_id = ?");
    args.push(batchId);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const rows = await gatewayDb.query<RedeemCodeRow>(
    `SELECT * FROM redeem_codes ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  const totalRow = await gatewayDb.queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM redeem_codes ${whereSql}`,
    args,
  );
  return {
    data: rows,
    total: totalRow?.total ?? 0,
  };
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
    `SELECT r.id, r.code_id, r.user_id, r.redeemed_at, c.code, u.username
       FROM redeem_redemptions r
       LEFT JOIN redeem_codes c ON c.id = r.code_id
       LEFT JOIN users u ON u.id = r.user_id
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
