import { NextResponse } from "next/server";

const UTC_TIMESTAMP_KEYS = new Set(["created_at", "updated_at", "deleted_at", "hour"]);

function toShanghaiIsoString(value: string) {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return value;

  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const seconds = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function normalizeTimeFields<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeTimeFields(item)) as T;
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (typeof value === "string" && UTC_TIMESTAMP_KEYS.has(key)) {
        return [key, toShanghaiIsoString(value)];
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

export function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
