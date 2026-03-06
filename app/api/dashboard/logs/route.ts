import { gatewayDb } from "@/lib/db";
import { ensureWebUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const isAdmin = guard.auth.user.role === "admin";
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const user = (url.searchParams.get("user") ?? "").trim();
  const model = (url.searchParams.get("model") ?? "").trim();
  const channel = (url.searchParams.get("channel") ?? "").trim();

  const whereClauses: string[] = [];
  const whereArgs: Array<string | number> = [];

  if (!isAdmin) {
    whereClauses.push("l.user_id = ?");
    whereArgs.push(guard.auth.user.id);
  } else if (user) {
    whereClauses.push("u.username LIKE ?");
    whereArgs.push(`%${user}%`);
  }

  if (model) {
    whereClauses.push("(l.model_alias LIKE ? OR l.real_model LIKE ?)");
    whereArgs.push(`%${model}%`, `%${model}%`);
  }

  if (channel) {
    whereClauses.push("c.name LIKE ?");
    whereArgs.push(`%${channel}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const rows = gatewayDb
    .prepare(
      `SELECT
         l.id, l.user_id, u.username, l.key_id, l.channel_id,
         c.name AS channel_name,
         l.model_alias, l.real_model, l.stream, l.status_code,
         l.estimated_tokens, l.prompt_tokens, l.completion_tokens, l.total_tokens,
         l.latency_ms, l.first_token_latency_ms, l.output_tps, l.route_attempts, l.attempted_channels,
         l.error_message, l.created_at
       FROM logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN channels c ON c.id = l.channel_id
       ${whereSql}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...whereArgs, limit, offset);

  const data = isAdmin
    ? rows
    : rows.map((row) => {
        const next = { ...(row as Record<string, unknown>) };
        delete next.username;
        delete next.channel_name;
        delete next.route_attempts;
        delete next.attempted_channels;
        return next;
      });

  const total = gatewayDb
    .prepare(
      `SELECT COUNT(*) AS total
       FROM logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN channels c ON c.id = l.channel_id
       ${whereSql}`,
    )
    .get(...whereArgs) as { total: number };

  const summary = gatewayDb
    .prepare(
      `SELECT
         COUNT(*) AS total_requests,
         SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failed_requests,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
         COALESCE(AVG(first_token_latency_ms), 0) AS avg_first_token_latency_ms,
         COALESCE(AVG(output_tps), 0) AS avg_output_tps
       FROM logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN channels c ON c.id = l.channel_id
       ${whereSql}`,
    )
    .get(...whereArgs) as {
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
