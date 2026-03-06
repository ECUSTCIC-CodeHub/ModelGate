import { z } from "zod";
import { hashPassword } from "@/lib/auth";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { softDeleteUser } from "@/lib/services/soft-delete-service";
import { USERNAME_SCHEMA } from "@/lib/username";

const updateSchema = z.object({
  username: USERNAME_SCHEMA.optional(),
  role: z.enum(["admin", "user"]).optional(),
  enabled: z.boolean().optional(),
  rpm: z.number().int().min(0).optional(),
  qps: z.number().int().min(0).optional(),
  tpm: z.number().int().min(0).optional(),
  quota_tokens: z.number().int().nonnegative().nullable().optional(),
  quota_requests: z.number().int().nonnegative().nullable().optional(),
  new_password: z.string().min(8).optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = gatewayDb
    .prepare(
      `SELECT id, username, role, enabled, rpm, qps, tpm, quota_tokens, quota_requests
       FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as
    | {
        id: number;
        username: string;
        role: "admin" | "user";
        enabled: number;
        rpm: number;
        qps: number;
        tpm: number;
        quota_tokens: number | null;
        quota_requests: number | null;
      }
    | undefined;

  if (!existing) return jsonError("用户不存在", 404);

  if (parsed.data.username !== undefined && parsed.data.username !== existing.username) {
    const duplicated = gatewayDb
      .prepare("SELECT id FROM users WHERE username = ? AND id != ?")
      .get(parsed.data.username, id) as { id: number } | undefined;
    if (duplicated) return jsonError("用户名已存在", 409);
  }

  const merged = {
    ...existing,
    ...parsed.data,
    enabled:
      parsed.data.enabled === undefined
        ? existing.enabled
        : parsed.data.enabled
          ? 1
          : 0,
  };

  const nextPasswordHash = parsed.data.new_password
    ? await hashPassword(parsed.data.new_password)
    : null;

  if (nextPasswordHash) {
    gatewayDb
      .prepare(
        `UPDATE users
         SET username = ?, role = ?, enabled = ?, rpm = ?, qps = ?, tpm = ?, quota_tokens = ?, quota_requests = ?, password_hash = ?
         WHERE id = ?`,
      )
      .run(
        merged.username,
        merged.role,
        merged.enabled,
        merged.rpm,
        merged.qps,
        merged.tpm,
        merged.quota_tokens,
        merged.quota_requests,
        nextPasswordHash,
        id,
      );
  } else {
    gatewayDb
      .prepare(
        `UPDATE users
         SET username = ?, role = ?, enabled = ?, rpm = ?, qps = ?, tpm = ?, quota_tokens = ?, quota_requests = ?
         WHERE id = ?`,
      )
      .run(
        merged.username,
        merged.role,
        merged.enabled,
        merged.rpm,
        merged.qps,
        merged.tpm,
        merged.quota_tokens,
        merged.quota_requests,
        id,
      );
  }

  const row = gatewayDb
    .prepare(
      `SELECT id, username, role, rpm, qps, tpm, quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id);

  return jsonOk({ message: "用户更新成功。", data: row });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const adminCount = gatewayDb.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1 AND deleted_at IS NULL").get() as {
    count: number;
  };

  const target = gatewayDb
    .prepare("SELECT role, enabled FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { role: "admin" | "user"; enabled: number } | undefined;

  if (!target) return jsonError("用户不存在", 404);
  if (target.role === "admin" && target.enabled === 1 && adminCount.count <= 1) {
    return jsonError("不能删除最后一个启用的管理员", 400);
  }

  softDeleteUser(id);
  return jsonOk({ ok: true, message: "用户删除成功。" });
}
