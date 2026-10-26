import { NextResponse } from "next/server";
import { isBusyError } from "@/lib/core/busy-error";
import { isDbCapacityError } from "@/lib/core/db/errors";

const TIMESTAMP_KEYS = new Set([
  "created_at",
  "updated_at",
  "deleted_at",
  "period_reset_at",
  "reset_at",
  "resetAt",
  "last_used_at",
  "expires_at",
]);

// 存储为 UTC 裸字符串（'YYYY-MM-DD HH:MM:SS'），补成 ISO UTC 带 Z 输出；
// 容忍 mysql2 dateStrings 返回的已是字符串、或上游已是 ISO 的输入。
function toUtcIsoString(value: string): string {
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(value);
  if (hasTz) {
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return value;
    return date.toISOString();
  }
  const space = value.includes("T") ? value.replace("T", " ") : value;
  const withMs = space.includes(".") ? space : `${space}.000`;
  const [datePart, timePart] = withMs.split(" ");
  if (!timePart) return value;
  const iso = `${datePart}T${timePart}Z`;
  return Number.isNaN(new Date(iso).getTime()) ? value : iso;
}

function normalizeTimeFields<T>(input: T): T {
  if (input instanceof Date) {
    return input.toISOString() as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => normalizeTimeFields(item)) as T;
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (TIMESTAMP_KEYS.has(key)) {
        if (value instanceof Date) {
          if (Number.isNaN(value.getTime())) return [key, null];
          return [key, value.toISOString()];
        }
        if (typeof value === "string") {
          return [key, toUtcIsoString(value)];
        }
        if (value === null || value === undefined) return [key, value];
      }
      return [key, normalizeTimeFields(value)];
    }),
  ) as T;
}

export function jsonOk(data: unknown, status = 200) {
  return NextResponse.json(normalizeTimeFields(data), { status });
}

type ApiErrorType =
  | "auth_error"
  | "invalid_request_error"
  | "not_found_error"
  | "rate_limit_error"
  | "conflict_error"
  | "upstream_error"
  | "server_error";

type JsonErrorOptions = {
  type?: ApiErrorType;
  param?: string;
  code?: string | number;
};

function inferErrorType(status: number): ApiErrorType {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

export function jsonError(message: string, status = 400, options: JsonErrorOptions = {}, extraHeaders?: Record<string, string>) {
  return NextResponse.json(
    {
      error: {
        message,
        type: options.type ?? inferErrorType(status),
        param: options.param ?? "None",
        code: String(options.code ?? status),
      },
    },
    { status, headers: extraHeaders },
  );
}

// 数据库容量类错误（连接池排队满 / 等待连接超时）统一按 503 快速失败，
// 让客户端退避重试，而不是和 SQL 执行失败混在同一个 500 里。
export function dbCapacityResponse(err: unknown): NextResponse | null {
  if (!isDbCapacityError(err)) return null;
  return jsonError("服务繁忙，请稍后重试", 503, {}, { "retry-after": "2" });
}

// 容量不足与锁冲突都属于「稍后重试即可」，统一映射成 503；
// 其余错误返回 null，由调用方继续上抛。
export function busyErrorResponse(err: unknown): NextResponse | null {
  const capacity = dbCapacityResponse(err);
  if (capacity) return capacity;
  if (isBusyError(err)) {
    return jsonError(err instanceof Error ? err.message : "服务繁忙，请稍后重试", 503, {}, { "retry-after": "2" });
  }
  return null;
}

export function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
