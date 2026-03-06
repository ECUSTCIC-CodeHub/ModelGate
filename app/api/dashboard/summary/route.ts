import { gatewayDb } from "@/lib/db";
import { ensureWebUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";

export async function GET(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const isAdmin = guard.auth.user.role === "admin";

  const summaryQuery = isAdmin
    ? gatewayDb.prepare(
        `SELECT
           COUNT(*) AS total_requests,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failed_requests,
           COUNT(DISTINCT user_id) AS active_users
         FROM chat_logs`,
      )
    : gatewayDb.prepare(
        `SELECT
           COUNT(*) AS total_requests,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failed_requests,
           1 AS active_users
         FROM chat_logs
         WHERE user_id = ?`,
      );

  const summary = (isAdmin ? summaryQuery.get() : summaryQuery.get(guard.auth.user.id)) as {
    total_requests: number;
    total_tokens: number;
    failed_requests: number;
    active_users: number;
  };

  const keyQuery = isAdmin
    ? gatewayDb.prepare("SELECT COUNT(*) AS total_keys FROM keys")
    : gatewayDb.prepare("SELECT COUNT(*) AS total_keys FROM keys WHERE user_id = ?");

  const keyData = (isAdmin ? keyQuery.get() : keyQuery.get(guard.auth.user.id)) as { total_keys: number };

  return jsonOk({
    data: {
      total_requests: summary.total_requests ?? 0,
      total_tokens: summary.total_tokens ?? 0,
      failed_requests: summary.failed_requests ?? 0,
      total_keys: keyData.total_keys ?? 0,
      active_users: summary.active_users ?? 0,
    },
  });
}
