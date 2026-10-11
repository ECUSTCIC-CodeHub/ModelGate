export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { resolveChannelOwnerId } from "@/lib/services/channel-ownership";

// 添加人按需取回明文密钥：列表与创建/更新响应始终只返回脱敏值，
// 明文只在这里单次返回，避免明文随列表批量下发后在浏览器侧长期驻留。
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const channel = await gatewayDb.queryOne<{
    api_key: string | null;
    api_key_private: number | null;
    created_by: number | null;
  }>("SELECT api_key, api_key_private, created_by FROM channels WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!channel) return jsonError("渠道不存在", 404);

  // 与列表/更新的可见性判定同一口径：私有渠道仅添加人可取明文，无主渠道任意管理员可取
  const ownerId = await resolveChannelOwnerId(channel.created_by);
  const canView = channel.api_key_private !== 1 || ownerId === null || ownerId === guard.auth.user.id;
  if (!canView) return jsonError("该渠道的 API Key 仅添加人可见", 403);

  return jsonOk({ data: { api_key: channel.api_key ?? "" } });
}
