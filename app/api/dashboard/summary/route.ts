export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureWebUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const isAdmin = guard.auth.user.role === "admin";
  const whereSql = isAdmin ? "" : "WHERE user_id = ?";
  const whereArgs = isAdmin ? [] : [guard.auth.user.id];

  const summary = gatewayDb
    .prepare(
      `SELECT
         COUNT(*) AS total_requests,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS failed_requests,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN output_tps END), 0) AS avg_output_tps,
         COALESCE(SUM(CASE WHEN route_attempts > 1 THEN 1 ELSE 0 END), 0) AS retry_requests
       FROM logs
       ${whereSql}`,
    )
    .get(...whereArgs) as {
    total_requests: number;
    total_tokens: number;
    failed_requests: number;
    avg_latency_ms: number;
    avg_output_tps: number;
    retry_requests: number;
  };

  const activeUsers = isAdmin
    ? ((gatewayDb
        .prepare(
          `SELECT COUNT(DISTINCT user_id) AS active_users
           FROM logs`,
        )
        .get() as { active_users: number }).active_users ?? 0)
    : 1;

  const keyQuery = isAdmin
    ? gatewayDb.prepare("SELECT COUNT(*) AS total_keys FROM keys WHERE deleted_at IS NULL")
    : gatewayDb.prepare("SELECT COUNT(*) AS total_keys FROM keys WHERE user_id = ? AND deleted_at IS NULL");

  const keyData = (isAdmin ? keyQuery.get() : keyQuery.get(guard.auth.user.id)) as { total_keys: number };

  const hourlyRows = gatewayDb
    .prepare(
      `SELECT
         strftime('%Y-%m-%dT%H:00:00', created_at) AS hour_bucket,
         COALESCE(SUM(total_tokens), 0) AS tokens
       FROM logs
       ${whereSql ? `${whereSql} AND` : "WHERE"} created_at >= datetime('now', '-23 hours')
       GROUP BY hour_bucket
       ORDER BY hour_bucket ASC`,
    )
    .all(...whereArgs) as Array<{ hour_bucket: string; tokens: number }>;

  const hourlyMap = new Map(hourlyRows.map((row) => [row.hour_bucket, row.tokens]));
  const hourlyTokens = Array.from({ length: 24 }, (_, index) => {
    const t = new Date(Date.now() - (23 - index) * 3600 * 1000);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, "0");
    const d = String(t.getUTCDate()).padStart(2, "0");
    const h = String(t.getUTCHours()).padStart(2, "0");
    const bucket = `${y}-${m}-${d}T${h}:00:00`;
    return {
      hour: bucket,
      tokens: hourlyMap.get(bucket) ?? 0,
    };
  });

  const topModels = gatewayDb
    .prepare(
      `SELECT
         COALESCE(model_alias, real_model, '-') AS model_name,
         COUNT(*) AS request_count,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM logs
       ${whereSql}
       GROUP BY model_name
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT 5`,
    )
    .all(...whereArgs);

  const topChannelWhereSql = isAdmin
    ? "WHERE l.status_code < 400 AND l.channel_id IS NOT NULL"
    : "WHERE l.user_id = ? AND l.status_code < 400 AND l.channel_id IS NOT NULL";

  const topChannels = gatewayDb
    .prepare(
      `SELECT
         COALESCE(c.name, '-') AS channel_name,
         COUNT(*) AS request_count,
         COALESCE(SUM(l.total_tokens), 0) AS total_tokens
       FROM logs l
       LEFT JOIN channels c ON c.id = l.channel_id
       ${topChannelWhereSql}
       GROUP BY channel_name
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT 5`,
    )
    .all(...whereArgs);

  const recentLogs = gatewayDb
    .prepare(
      `SELECT
         id,
         COALESCE(model_alias, real_model, '-') AS model_name,
         status_code,
         total_tokens,
         latency_ms,
         created_at
       FROM logs
       ${whereSql}
       ORDER BY id DESC
       LIMIT 8`,
    )
    .all(...whereArgs);

  return jsonOk({
    data: {
      total_requests: summary.total_requests ?? 0,
      total_tokens: summary.total_tokens ?? 0,
      failed_requests: summary.failed_requests ?? 0,
      total_keys: keyData.total_keys ?? 0,
      active_users: activeUsers,
      avg_latency_ms: summary.avg_latency_ms ?? 0,
      avg_output_tps: summary.avg_output_tps ?? 0,
      retry_requests: summary.retry_requests ?? 0,
      success_rate: (summary.total_requests ?? 0) > 0
        ? Number((((summary.total_requests - summary.failed_requests) / summary.total_requests) * 100).toFixed(2))
        : 0,
      hourly_tokens: hourlyTokens,
      top_models: topModels,
      top_channels: topChannels,
      recent_logs: recentLogs,
    },
  });
}
