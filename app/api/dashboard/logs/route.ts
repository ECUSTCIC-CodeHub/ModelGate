export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";

function escapeLike(input: string): string {
  return input.replace(/\|/g, "||").replace(/%/g, "|%").replace(/_/g, "|_");
}

function parseDateParam(value: string) {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

function addOneDay(dateText: string) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

type KeyFilter =
  | { kind: "exact"; key: string }
  | { kind: "fingerprint"; front: string; back: string }
  | { kind: "short"; nibble: string }
  | { kind: "name"; text: string };

function parseKeyFilter(raw: string): KeyFilter {
  const text = raw.trim();
  const stripped = text.toLowerCase().replace(/^sk-gw-/, "");
  const dotted = /^([0-9a-f]{4})\.{3}([0-9a-f]{4})$/.exec(stripped);
  if (dotted) return { kind: "fingerprint", front: dotted[1], back: dotted[2] };
  if (/^[0-9a-f]{36}$/.test(stripped)) return { kind: "exact", key: `sk-gw-${stripped}` };
  if (/^[0-9a-f]{8}$/.test(stripped)) {
    return { kind: "fingerprint", front: stripped.slice(0, 4), back: stripped.slice(4) };
  }
  if (/^[0-9a-f]{4}$/.test(stripped)) return { kind: "short", nibble: stripped };
  return { kind: "name", text };
}

function maskKey(value: string | null): string | null {
  if (!value) return null;
  return value.length > 14 ? `${value.slice(0, 10)}...${value.slice(-4)}` : `${value.slice(0, 4)}...`;
}

function parseLogMetadata(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const isAdmin = guard.auth.user.role === "admin";
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const user = (url.searchParams.get("user") ?? "").trim();
  const model = (url.searchParams.get("model") ?? "").trim();
  const channel = (url.searchParams.get("channel") ?? "").trim();
  const ip = (url.searchParams.get("ip") ?? "").trim();
  const key = (url.searchParams.get("key") ?? "").trim();
  const startDate = parseDateParam(url.searchParams.get("start_date") ?? "");
  const endDate = parseDateParam(url.searchParams.get("end_date") ?? "");
  const status = (url.searchParams.get("status") ?? "").trim();

  const whereClauses: string[] = [];
  const whereArgs: Array<string | number> = [];

  if (!isAdmin) {
    whereClauses.push("l.user_id = ?");
    whereArgs.push(guard.auth.user.id);
  } else if (user) {
    whereClauses.push("u.username LIKE ? ESCAPE '|'");
    whereArgs.push(`%${escapeLike(user)}%`);
  }

  if (model) {
    whereClauses.push("(l.model_alias LIKE ? ESCAPE '|' OR l.real_model LIKE ? ESCAPE '|')");
    whereArgs.push(`%${escapeLike(model)}%`, `%${escapeLike(model)}%`);
  }

  if (channel) {
    whereClauses.push("c.name LIKE ? ESCAPE '|'");
    whereArgs.push(`%${escapeLike(channel)}%`);
  }

  if (ip) {
    whereClauses.push("l.client_ip LIKE ? ESCAPE '|'");
    whereArgs.push(`%${escapeLike(ip)}%`);
  }

  if (key) {
    const parsed = parseKeyFilter(key);
    if (parsed.kind === "exact") {
      whereClauses.push("k.`key` = ?");
      whereArgs.push(parsed.key);
    } else if (parsed.kind === "fingerprint") {
      whereClauses.push("k.`key` LIKE ? ESCAPE '|'");
      whereArgs.push(`sk-gw-${escapeLike(parsed.front)}%${escapeLike(parsed.back)}`);
    } else if (parsed.kind === "short") {
      whereClauses.push("(k.`key` LIKE ? ESCAPE '|' OR k.`key` LIKE ? ESCAPE '|')");
      whereArgs.push(`sk-gw-${escapeLike(parsed.nibble)}%`, `%${escapeLike(parsed.nibble)}`);
    } else {
      whereClauses.push("LOWER(k.name) LIKE ? ESCAPE '|'");
      whereArgs.push(`%${escapeLike(parsed.text.toLowerCase())}%`);
    }
  }

  if (startDate) {
    whereClauses.push("l.created_at >= ?");
    whereArgs.push(`${startDate} 00:00:00`);
  }

  if (endDate) {
    const nextDate = addOneDay(endDate);
    if (nextDate) {
      whereClauses.push("l.created_at < ?");
      whereArgs.push(`${nextDate} 00:00:00`);
    }
  }

  if (status === "failed") {
    whereClauses.push("l.status_code >= 400");
  } else if (status === "success") {
    whereClauses.push("l.status_code < 400");
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const rows = await gatewayDb
    .query<Record<string, unknown>>(
      `SELECT
         l.id, l.user_id, u.username, l.key_id, l.channel_id,
         c.name AS channel_name,
         k.name AS key_name, k.key AS key_value,
         l.model_alias, l.real_model, l.stream, l.status_code,
         l.estimated_tokens, l.prompt_tokens, l.completion_tokens, l.total_tokens,
         l.token_source, l.metadata, l.latency_ms, l.first_token_latency_ms, l.output_tps, l.route_attempts, l.attempted_channels,
         l.error_message, l.client_ip, l.user_agent, l.created_at
       FROM logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN channels c ON c.id = l.channel_id
       LEFT JOIN \`keys\` k ON k.id = l.key_id
       ${whereSql}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [...whereArgs, limit, offset],
    );

  const data = rows.map((row) => {
    const next = { ...row };
    next.key_masked = maskKey(typeof next.key_value === "string" ? next.key_value : null);
    next.metadata = parseLogMetadata(next.metadata);
    delete next.key_value;
    if (!isAdmin) {
      delete next.username;
      delete next.channel_name;
      delete next.route_attempts;
      delete next.attempted_channels;
    }
    return next;
  });

  const total = (await gatewayDb
    .queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN channels c ON c.id = l.channel_id
       LEFT JOIN \`keys\` k ON k.id = l.key_id
       ${whereSql}`,
      whereArgs,
    ))!;

  const summary = (await gatewayDb
    .queryOne<{
    total_requests: number;
    failed_requests: number;
    total_tokens: number;
    avg_latency_ms: number;
    avg_first_token_latency_ms: number;
    avg_output_tps: number;
  }>(
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
       LEFT JOIN \`keys\` k ON k.id = l.key_id
       ${whereSql}`,
      whereArgs,
    ))!;

  return jsonOk({
    summary,
    data,
    paging: { limit, offset, total: total.total },
  });
}
