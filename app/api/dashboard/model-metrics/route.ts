export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { listAccessibleModelAliases } from "@/lib/gateway/model-access";

type HourlyRow = {
  model_alias: string;
  hour_bucket: number;
  request_count: number;
  success_rate: number;
};

type OverallRow = {
  model_alias: string;
  avg_latency_ms: number;
  avg_output_tps: number;
};

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const isMysql = await gatewayDb.getDriver() === "mysql";
  const hoursAgo = (n: number) =>
    isMysql
      ? `DATE_SUB(NOW(), INTERVAL ${n} HOUR)`
      : `datetime('now', '-${n} hours')`;

  const hourBucketExpr = isMysql
    ? `CASE
         WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN 0
         WHEN created_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR) THEN 1
         ELSE 2
       END`
    : `CASE
         WHEN created_at >= datetime('now', '-1 hour') THEN 0
         WHEN created_at >= datetime('now', '-2 hours') THEN 1
         ELSE 2
       END`;

  const hourlyRows = await gatewayDb.query<HourlyRow>(
    `SELECT
       model_alias,
       ${hourBucketExpr} AS hour_bucket,
       COUNT(*) AS request_count,
       COALESCE(
         SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) * 100.0
           / NULLIF(SUM(CASE WHEN status_code != 429 THEN 1 ELSE 0 END), 0),
         0
       ) AS success_rate
     FROM logs
     WHERE created_at >= ${hoursAgo(3)}
       AND model_alias IS NOT NULL
     GROUP BY model_alias, hour_bucket`,
  );

  const overallRows = await gatewayDb.query<OverallRow>(
    `SELECT
       model_alias,
       COALESCE(AVG(CASE WHEN status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms,
       COALESCE(AVG(CASE WHEN status_code < 400 THEN output_tps END), 0) AS avg_output_tps
     FROM logs
     WHERE created_at >= ${hoursAgo(3)}
       AND model_alias IS NOT NULL
     GROUP BY model_alias`,
  );

  const overallMap = new Map<string, OverallRow>();
  for (const row of overallRows) {
    overallMap.set(row.model_alias, row);
  }

  const data: Record<
    string,
    {
      avg_latency_ms: number;
      avg_output_tps: number;
      hourly: Array<{ hour: number; success_rate: number; request_count: number }>;
    }
  > = {};

  for (const row of hourlyRows) {
    if (!data[row.model_alias]) {
      const overall = overallMap.get(row.model_alias);
      data[row.model_alias] = {
        avg_latency_ms: Math.round(overall?.avg_latency_ms ?? 0),
        avg_output_tps: Number((overall?.avg_output_tps ?? 0).toFixed(1)),
        hourly: [],
      };
    }
    data[row.model_alias].hourly.push({
      hour: row.hour_bucket,
      success_rate: Number(row.success_rate.toFixed(1)),
      request_count: row.request_count,
    });
  }

  // Fill missing hour buckets with zero data
  for (const key of Object.keys(data)) {
    const existing = new Set(data[key].hourly.map((h) => h.hour));
    for (const hour of [0, 1, 2]) {
      if (!existing.has(hour)) {
        data[key].hourly.push({ hour, success_rate: 0, request_count: 0 });
      }
    }
    data[key].hourly.sort((a, b) => a.hour - b.hour);
  }

  // Filter by accessible models for non-admin users
  const user = guard.auth.user;
  if (user.role !== "admin") {
    const accessible = new Set(await listAccessibleModelAliases(user));
    for (const key of Object.keys(data)) {
      if (!accessible.has(key)) delete data[key];
    }
  }

  return jsonOk({ data });
}
