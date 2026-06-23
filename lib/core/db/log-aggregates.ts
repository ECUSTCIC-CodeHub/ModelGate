export const FAILED_REQUESTS_EXPR =
  "COALESCE(SUM(CASE WHEN status_code >= 400 AND status_code != 429 THEN 1 ELSE 0 END), 0)";
export const RATE_LIMITED_REQUESTS_EXPR =
  "COALESCE(SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END), 0)";

export function statusFilterClause(status: string): string | null {
  if (status === "failed") return "status_code >= 400 AND status_code != 429";
  if (status === "rate_limited") return "status_code = 429";
  if (status === "success") return "status_code < 400";
  return null;
}
