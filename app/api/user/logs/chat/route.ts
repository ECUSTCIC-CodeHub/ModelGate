export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { FAILED_REQUESTS_EXPR, RATE_LIMITED_REQUESTS_EXPR } from "@/lib/core/db/log-aggregates";
import { ensureUser } from "@/lib/auth/guards";
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
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const rows = await gatewayDb
    .query<Record<string, unknown>>(
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
       WHERE l.user_id = ?
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [guard.auth.user.id, limit, offset],
    );

  const data = rows.map((row) => ({
    ...row,
    metadata: parseLogMetadata(row.metadata),
  }));

  const total = (await gatewayDb
    .queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM logs WHERE user_id = ?", [guard.auth.user.id]))!;

  const summary = (await gatewayDb
    .queryOne<{
    total_requests: number;
    failed_requests: number;
    rate_limited_requests: number;
    total_tokens: number;
    avg_latency_ms: number;
    avg_first_token_latency_ms: number;
    avg_output_tps: number;
  }>(
      `SELECT
         COUNT(*) AS total_requests,
         ${FAILED_REQUESTS_EXPR} AS failed_requests,
         ${RATE_LIMITED_REQUESTS_EXPR} AS rate_limited_requests,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN first_token_latency_ms END), 0) AS avg_first_token_latency_ms,
         COALESCE(AVG(CASE WHEN status_code < 400 THEN output_tps END), 0) AS avg_output_tps
       FROM logs
       WHERE user_id = ?`,
      [guard.auth.user.id],
    ))!;

  return jsonOk({
    summary,
    data,
    paging: { limit, offset, total: total.total },
  });
}
