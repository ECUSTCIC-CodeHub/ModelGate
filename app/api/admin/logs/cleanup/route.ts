export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { gatewayDb } from "@/lib/core/db";
import { pruneOldLogs, pruneOldEmailLogs } from "@/lib/data/log-cleanup";

const MAX_RETENTION_DAYS = 3650;

const schema = z.object({
  // 显式拒绝 0：0 语义是「不自动清理」，手动清理传 0 会删空整表，属误操作
  days: z.number().int().min(1).max(MAX_RETENTION_DAYS).optional(),
});

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);

  const raw = body.data ?? {};
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(`保留天数需为 1-${MAX_RETENTION_DAYS} 的整数`, 400);
  }

  let days = parsed.data.days;
  if (days === undefined) {
    // 未指定时回落到已保存的设置值
    const row = await gatewayDb.queryOne<{ value: string }>(
      "SELECT value FROM settings WHERE `key` = ?",
      ["log_retention_days"],
    );
    const stored = Number(row?.value ?? 0);
    if (!Number.isFinite(stored) || stored <= 0 || stored > MAX_RETENTION_DAYS) {
      return jsonError(`未指定保留天数且系统设置的保留天数无效，请传入 1-${MAX_RETENTION_DAYS} 的整数`, 400);
    }
    days = Math.trunc(stored);
  }

  try {
    const deleted = await pruneOldLogs(gatewayDb, days);
    // 渠道日志与邮件发送日志一起清理，避免只删一半留下孤立记录
    await pruneOldEmailLogs(gatewayDb, days);
    return jsonOk({ message: `已清理 ${deleted} 条日志。`, data: { deleted, days } });
  } catch {
    return jsonError("清理日志失败", 500);
  }
}
