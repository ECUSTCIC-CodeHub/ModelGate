export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { listAccessibleModelAliases } from "@/lib/gateway/model-access";
import { getGatewaySettings } from "@/lib/core/settings";
import { clampStatusLightHours } from "@/lib/shared/utils";

type MetricRow = {
  model_alias: string;
  avg_latency_ms: number | null;
  avg_output_tps: number | null;
  cnt_0: number;
  ok_0: number;
  den_0: number;
  cnt_1: number;
  ok_1: number;
  den_1: number;
  cnt_2: number;
  ok_2: number;
  den_2: number;
};

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const settings = await getGatewaySettings();
  const hours = [
    clampStatusLightHours(settings.model_status_light_1_hours, 1),
    clampStatusLightHours(settings.model_status_light_2_hours, 2),
    clampStatusLightHours(settings.model_status_light_3_hours, 3),
  ];

  const isMysql = await gatewayDb.getDriver() === "mysql";
  const maxHours = Math.max(...hours);

  const windowExpr = (h: number) =>
    isMysql
      ? `created_at >= DATE_SUB(NOW(), INTERVAL ${h} HOUR)`
      : `created_at >= datetime('now', '-${h} hours')`;

  const overallWindow = windowExpr(maxHours);

  const lightSelects = hours
    .map((h, i) => {
      const w = windowExpr(h);
      return `
        SUM(CASE WHEN ${w} AND status_code != 429 THEN 1 ELSE 0 END) AS cnt_${i},
        SUM(CASE WHEN ${w} AND status_code < 400 THEN 1 ELSE 0 END) AS ok_${i},
        SUM(CASE WHEN ${w} AND status_code != 429 THEN 1 ELSE 0 END) AS den_${i}`;
    })
    .join(",");

  const rows = await gatewayDb.query<MetricRow>(
    `SELECT
       model_alias,
       COALESCE(AVG(CASE WHEN ${overallWindow} AND status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms,
       COALESCE(AVG(CASE WHEN ${overallWindow} AND status_code < 400 THEN output_tps END), 0) AS avg_output_tps,
       ${lightSelects}
     FROM logs
     WHERE ${overallWindow}
       AND model_alias IS NOT NULL
     GROUP BY model_alias`,
  );

  const data: Record<
    string,
    {
      avg_latency_ms: number;
      avg_output_tps: number;
      hourly: Array<{ hours: number; success_rate: number; request_count: number }>;
    }
  > = {};

  for (const row of rows) {
    const hourly = hours
      .map((h, i) => {
        const cnt = Number(row[`cnt_${i}` as keyof MetricRow] ?? 0);
        const ok = Number(row[`ok_${i}` as keyof MetricRow] ?? 0);
        const den = Number(row[`den_${i}` as keyof MetricRow] ?? 0);
        const success_rate = den > 0 ? Number(((ok * 100) / den).toFixed(1)) : 0;
        return { hours: h, success_rate, request_count: cnt };
      })
      .sort((a, b) => b.hours - a.hours);

    data[row.model_alias] = {
      avg_latency_ms: Math.round(row.avg_latency_ms ?? 0),
      avg_output_tps: Number((row.avg_output_tps ?? 0).toFixed(1)),
      hourly,
    };
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
