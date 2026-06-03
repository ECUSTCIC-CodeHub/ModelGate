export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";

function parseLogMetadata(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const rows = gatewayDb
    .prepare(
      `SELECT
         l.id, l.user_id, u.username, l.key_id, l.channel_id,
         c.name AS channel_name,
         l.model_alias, l.real_model, l.stream, l.status_code,
         l.estimated_tokens, l.prompt_tokens, l.completion_tokens, l.total_tokens,
         l.latency_ms, l.first_token_latency_ms, l.output_tps, l.token_source, l.metadata,
         l.error_message, l.client_ip, l.user_agent, l.created_at
       FROM logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN channels c ON c.id = l.channel_id
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<Record<string, unknown>>;

  const data = rows.map((row) => ({
    ...row,
    metadata: parseLogMetadata(row.metadata),
  }));

  const total = gatewayDb
    .prepare("SELECT COUNT(*) AS total FROM logs")
    .get() as { total: number };

  const summary = gatewayDb
    .prepare(
      `SELECT
         COUNT(*) AS total_requests,
         SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failed_requests,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
         COALESCE(AVG(first_token_latency_ms), 0) AS avg_first_token_latency_ms,
         COALESCE(AVG(output_tps), 0) AS avg_output_tps
       FROM logs`,
    )
    .get() as {
    total_requests: number;
    failed_requests: number;
    total_tokens: number;
    avg_latency_ms: number;
    avg_first_token_latency_ms: number;
    avg_output_tps: number;
  };

  return jsonOk({
    summary,
    data,
    paging: { limit, offset, total: total.total },
  });
}
