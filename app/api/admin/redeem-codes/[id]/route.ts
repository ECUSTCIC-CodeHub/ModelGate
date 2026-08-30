export const dynamic = "force-dynamic";

import { requireFeature } from "@/lib/core/features";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { getCodeById, listRedemptions } from "@/lib/services/redeem-codes";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unavailable = requireFeature("redeemCode");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const codeId = Number(id);
  if (!Number.isFinite(codeId) || codeId <= 0) return jsonError("参数不正确", 400);

  const code = await getCodeById(codeId);
  if (!code) return jsonError("兑换码不存在", 404);

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const redemptions = await listRedemptions({ codeId, limit, offset });
  return jsonOk({ data: code, redemptions });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unavailable = requireFeature("redeemCode");
  if (unavailable) return unavailable;

  const guard = await ensureAdmin(_request);
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const codeId = Number(id);
  if (!Number.isFinite(codeId) || codeId <= 0) return jsonError("参数不正确", 400);

  const code = await getCodeById(codeId);
  if (!code) return jsonError("兑换码不存在", 404);

  await gatewayDb.transaction(async (tx) => {
    await tx.execute("DELETE FROM redeem_redemptions WHERE code_id = ?", [codeId]);
    await tx.execute("DELETE FROM redeem_balances WHERE code_id = ?", [codeId]);
    await tx.execute("DELETE FROM redeem_codes WHERE id = ?", [codeId]);
  });

  return jsonOk({ message: "兑换码已删除。" });
}
