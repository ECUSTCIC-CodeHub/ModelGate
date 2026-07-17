export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { FAILED_REQUESTS_EXPR, RATE_LIMITED_REQUESTS_EXPR } from "@/lib/core/db/log-aggregates";
import { getGatewaySettings } from "@/lib/core/settings";
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
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const isAdmin = guard.auth.user.role === "admin";
  // 概览统计默认对普通用户展示站点级全貌；仅“密钥数量”按当前用户隔离（可管理的密钥）
  const keyWhereArgs = isAdmin ? [] : [guard.auth.user.id];

  let logRetentionDays = 0;
  let topUsersVisible = 0;
  let overviewGlobal = 0;
  try {
    const gatewaySettings = await getGatewaySettings();
    logRetentionDays = gatewaySettings.log_retention_days;
    topUsersVisible = gatewaySettings.top_users_visible;
    overviewGlobal = gatewaySettings.overview_global;
  } catch {
    // 读取设置失败不影响首页统计加载；故障安全回退为隐藏（普通用户不显示用户排行榜与站点级概览）
  }

  const showGlobal = isAdmin || overviewGlobal === 1;
  const overviewWhereSql = showGlobal ? "" : "WHERE user_id = ?";
  const overviewWhereArgs = showGlobal ? [] : [guard.auth.user.id];

  type SummaryCore = {
    total_requests: number;
    total_tokens: number;
    failed_requests: number;
    rate_limited_requests: number;
    avg_latency_ms: number;
    avg_output_tps: number;
    retry_requests: number;
  };

  let summary: SummaryCore;
  if (showGlobal) {
    const stats = await gatewayDb.queryOne<{
      total_requests: number;
      total_tokens: number;
      failed_requests: number;
      rate_limited_requests: number;
      retry_requests: number;
    }>("SELECT total_requests, total_tokens, failed_requests, rate_limited_requests, retry_requests FROM stats WHERE id = 1");
    const avgRow = await gatewayDb.queryOne<{ avg_latency_ms: number; avg_output_tps: number }>(
      `SELECT
         COALESCE(AVG(CASE WHEN status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN output_tps END), 0) AS avg_output_tps
       FROM logs`,
    );
    summary = {
      total_requests: stats?.total_requests ?? 0,
      total_tokens: stats?.total_tokens ?? 0,
      failed_requests: stats?.failed_requests ?? 0,
      rate_limited_requests: stats?.rate_limited_requests ?? 0,
      retry_requests: stats?.retry_requests ?? 0,
      avg_latency_ms: avgRow?.avg_latency_ms ?? 0,
      avg_output_tps: avgRow?.avg_output_tps ?? 0,
    };
  } else {
    const row = await gatewayDb.queryOne<SummaryCore>(
      `SELECT
         COUNT(*) AS total_requests,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         ${FAILED_REQUESTS_EXPR} AS failed_requests,
         ${RATE_LIMITED_REQUESTS_EXPR} AS rate_limited_requests,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN output_tps END), 0) AS avg_output_tps,
         COALESCE(SUM(CASE WHEN route_attempts > 1 THEN 1 ELSE 0 END), 0) AS retry_requests
       FROM logs
       ${overviewWhereSql}`,
      overviewWhereArgs,
    );
    summary = {
      total_requests: row?.total_requests ?? 0,
      total_tokens: row?.total_tokens ?? 0,
      failed_requests: row?.failed_requests ?? 0,
      rate_limited_requests: row?.rate_limited_requests ?? 0,
      avg_latency_ms: row?.avg_latency_ms ?? 0,
      avg_output_tps: row?.avg_output_tps ?? 0,
      retry_requests: row?.retry_requests ?? 0,
    };
  }

  const activeUsers = showGlobal
    ? (await gatewayDb.queryOne<{ active_users: number }>(
        `SELECT COUNT(DISTINCT user_id) AS active_users
         FROM logs`,
      ))?.active_users ?? 0
    : 1;

  const keyData = await gatewayDb.queryOne<{ total_keys: number }>(
    isAdmin
      ? "SELECT COUNT(*) AS total_keys FROM `keys` WHERE deleted_at IS NULL"
      : "SELECT COUNT(*) AS total_keys FROM `keys` WHERE user_id = ? AND deleted_at IS NULL",
    keyWhereArgs,
  );

  const isMysql = await gatewayDb.getDriver() === "mysql";
  const hourBucketExpr = isMysql
    ? "DATE_FORMAT(created_at, '%Y-%m-%dT%H:00:00')"
    : "strftime('%Y-%m-%dT%H:00:00', created_at)";
  const hoursAgo = (n: number) => isMysql
    ? `DATE_SUB(NOW(), INTERVAL ${n} HOUR)`
    : `datetime('now', '-${n} hours')`;
  const daysAgo = (n: number) => isMysql
    ? `DATE_SUB(NOW(), INTERVAL ${n} DAY)`
    : `datetime('now', '-${n} days')`;
  const endMsExpr = isMysql
    ? "UNIX_TIMESTAMP(created_at) * 1000"
    : "CAST(unixepoch(created_at) * 1000 AS INTEGER)";

  const hourlyRows = await gatewayDb
    .query<{ hour_bucket: string; tokens: number }>(
      `SELECT
         ${hourBucketExpr} AS hour_bucket,
         COALESCE(SUM(total_tokens), 0) AS tokens
       FROM logs
       ${overviewWhereSql ? `${overviewWhereSql} AND` : "WHERE"} created_at >= ${hoursAgo(23)}
       GROUP BY hour_bucket
       ORDER BY hour_bucket ASC`,
      overviewWhereArgs,
    );

  const shanghaiBucketFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const formatShanghaiBucket = (date: Date): string => {
    const parts = shanghaiBucketFmt.formatToParts(date);
    const g = (t: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === t)?.value ?? "00";
    const hour = g("hour") === "24" ? "00" : g("hour");
    return `${g("year")}-${g("month")}-${g("day")}T${hour}:00:00`;
  };

  const hourlyMap = new Map(hourlyRows.map((row) => [row.hour_bucket, row.tokens]));
  const hourlyTokens = Array.from({ length: 24 }, (_, index) => {
    const t = new Date(Date.now() - (23 - index) * 3600 * 1000);
    const bucket = isMysql
      ? formatShanghaiBucket(t)
      : (() => {
          const y = t.getUTCFullYear();
          const m = String(t.getUTCMonth() + 1).padStart(2, "0");
          const d = String(t.getUTCDate()).padStart(2, "0");
          const h = String(t.getUTCHours()).padStart(2, "0");
          return `${y}-${m}-${d}T${h}:00:00`;
        })();
    return {
      hour: bucket,
      tokens: hourlyMap.get(bucket) ?? 0,
    };
  });

  const topModels = await gatewayDb
    .query(
      `SELECT
         COALESCE(model_alias, real_model, '-') AS model_name,
         COUNT(*) AS request_count,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM logs
       ${overviewWhereSql}
       GROUP BY model_name
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT 5`,
      overviewWhereArgs,
    );

  const topChannelWhereSql = `${overviewWhereSql ? `${overviewWhereSql} AND` : "WHERE"} l.status_code < 400 AND l.channel_id IS NOT NULL`;

  const topChannels = await gatewayDb
    .query(
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
      overviewWhereArgs,
    );

  const topUsers = (isAdmin || topUsersVisible === 1)
    ? await gatewayDb
      .query(
        `SELECT
          user_id,
          COALESCE(u.username, '-') AS username,
          COUNT(*) AS request_count,
          ${FAILED_REQUESTS_EXPR} AS failed_requests,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(AVG(CASE WHEN status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms
        FROM logs
        LEFT JOIN users u ON u.id = logs.user_id
        GROUP BY user_id
        ORDER BY total_tokens DESC, request_count DESC
        LIMIT 5`,
      )
    : [];

  const concurrencyRows = await gatewayDb
    .query<{ end_ms: number; latency_ms: number }>(
      `SELECT
         ${endMsExpr} AS end_ms,
         latency_ms
       FROM logs
       ${overviewWhereSql ? `${overviewWhereSql} AND` : "WHERE"} channel_id IS NOT NULL
         AND latency_ms IS NOT NULL
         AND latency_ms > 0
         AND created_at >= ${hoursAgo(24)}`,
      overviewWhereArgs,
    );

  const concurrency = estimateConcurrency(concurrencyRows);
  const successRateBase = Math.max(0, (summary.total_requests ?? 0) - (summary.rate_limited_requests ?? 0));
  const successCount = Math.max(0, successRateBase - (summary.failed_requests ?? 0));

  const recentFailedData = await gatewayDb.queryOne<{ recent_failed_requests: number }>(
    `SELECT ${FAILED_REQUESTS_EXPR} AS recent_failed_requests
     FROM logs
     ${overviewWhereSql ? `${overviewWhereSql} AND` : "WHERE"} created_at >= ${daysAgo(30)}`,
    overviewWhereArgs,
  );
  const recentFailed = recentFailedData?.recent_failed_requests ?? 0;

  return jsonOk({
    data: {
      total_requests: summary.total_requests ?? 0,
      total_tokens: summary.total_tokens ?? 0,
      failed_requests: summary.failed_requests ?? 0,
      recent_failed_requests: recentFailed,
      total_keys: keyData?.total_keys ?? 0,
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
      log_retention_days: logRetentionDays,
      top_users_visible: topUsersVisible,
      overview_global: overviewGlobal,
      hourly_tokens: hourlyTokens,
      top_models: topModels,
      top_channels: topChannels,
      top_users: topUsers,
    },
  });
}
