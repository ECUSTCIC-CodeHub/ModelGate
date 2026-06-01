export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";

function estimateConcurrency(rows: Array<{ end_ms: number; latency_ms: number }>) {
  const now = Date.now();
  const windowStart = now - 24 * 60 * 60 * 1000;
  const events: Array<{ ts: number; delta: number }> = [];

  for (const row of rows) {
    if (!Number.isFinite(row.end_ms) || !Number.isFinite(row.latency_ms) || row.latency_ms <= 0) continue;
    const end = Math.min(now, row.end_ms);
    const start = Math.max(windowStart, end - row.latency_ms);
    if (end <= start) continue;
    events.push({ ts: start, delta: 1 });
    events.push({ ts: end, delta: -1 });
  }

  if (events.length === 0) {
    return { estimated_peak_concurrency: 0, estimated_avg_concurrency: 0 };
  }

  events.sort((a, b) => (a.ts === b.ts ? a.delta - b.delta : a.ts - b.ts));

  let active = 0;
  let peak = 0;
  let weightedTotal = 0;
  let previousTs = windowStart;

  for (const event of events) {
    if (event.ts > previousTs) {
      weightedTotal += active * (event.ts - previousTs);
      previousTs = event.ts;
    }
    active += event.delta;
    if (active > peak) peak = active;
  }

  if (previousTs < now) {
    weightedTotal += active * (now - previousTs);
  }

  return {
    estimated_peak_concurrency: peak,
    estimated_avg_concurrency: Number((weightedTotal / (24 * 60 * 60 * 1000)).toFixed(2)),
  };
}

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
         COALESCE(SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END), 0) AS rate_limited_requests,
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
    rate_limited_requests: number;
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

  const concurrencyRows = gatewayDb
    .prepare(
      `SELECT
         CAST(unixepoch(created_at) * 1000 AS INTEGER) AS end_ms,
         latency_ms
       FROM logs
       ${whereSql ? `${whereSql} AND` : "WHERE"} channel_id IS NOT NULL
         AND latency_ms IS NOT NULL
         AND latency_ms > 0
         AND created_at >= datetime('now', '-24 hours')`,
    )
    .all(...whereArgs) as Array<{ end_ms: number; latency_ms: number }>;

  const concurrency = estimateConcurrency(concurrencyRows);
  const successRateBase = Math.max(0, (summary.total_requests ?? 0) - (summary.rate_limited_requests ?? 0));
  const successCount = Math.max(0, successRateBase - ((summary.failed_requests ?? 0) - (summary.rate_limited_requests ?? 0)));

  const recentFailed = isAdmin
    ? ((gatewayDb
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS recent_failed_requests
           FROM logs
           WHERE created_at >= datetime('now', '-30 days')`,
        )
        .get() as { recent_failed_requests: number }).recent_failed_requests ?? 0)
    : ((gatewayDb
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS recent_failed_requests
           FROM logs
           WHERE user_id = ? AND created_at >= datetime('now', '-30 days')`,
        )
        .get(guard.auth.user.id) as { recent_failed_requests: number }).recent_failed_requests ?? 0);

  return jsonOk({
    data: {
      total_requests: summary.total_requests ?? 0,
      total_tokens: summary.total_tokens ?? 0,
      failed_requests: summary.failed_requests ?? 0,
      recent_failed_requests: recentFailed,
      total_keys: keyData.total_keys ?? 0,
      active_users: activeUsers,
      avg_latency_ms: summary.avg_latency_ms ?? 0,
      avg_output_tps: summary.avg_output_tps ?? 0,
      retry_requests: summary.retry_requests ?? 0,
      rate_limited_requests: summary.rate_limited_requests ?? 0,
      success_rate: successRateBase > 0
        ? Number(((successCount / successRateBase) * 100).toFixed(2))
        : 0,
      estimated_peak_concurrency: concurrency.estimated_peak_concurrency,
      estimated_avg_concurrency: concurrency.estimated_avg_concurrency,
      hourly_tokens: hourlyTokens,
      top_models: topModels,
      top_channels: topChannels,
    },
  });
}
