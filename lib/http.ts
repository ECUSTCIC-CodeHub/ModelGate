import { NextResponse } from "next/server";

export function jsonOk(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
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

export function jsonError(message: string, status = 400, options: JsonErrorOptions = {}) {
  return NextResponse.json(
    {
      error: {
        message,
        type: options.type ?? inferErrorType(status),
        param: options.param ?? "None",
        code: String(options.code ?? status),
      },
    },
    { status },
  );
}

export function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
