export const dynamic = "force-dynamic";

import { jsonError } from "@/lib/http";

function notFound() {
  return jsonError("API 接口不存在", 404, {
    type: "not_found_error",
    param: "None",
    code: "404",
  });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
export const HEAD = notFound;
