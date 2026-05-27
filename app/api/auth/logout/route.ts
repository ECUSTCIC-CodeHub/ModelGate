export const dynamic = "force-dynamic";

import { clearAuthCookies } from "@/lib/auth";
import { jsonOk } from "@/lib/http";
import { NextResponse } from "next/server";

export async function POST() {
  return clearAuthCookies(jsonOk({ ok: true, message: "退出登录成功。" }));
}

function resolveSafeNext(request: Request) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") ?? "/login";
  if (!next.startsWith("/") || next.startsWith("//")) return "/login";
  return next;
}

export async function GET(request: Request) {
  // 使用相对路径作为 Location 头，避免依赖 request.url 解析出的 host
  // （在反代 / standalone 模式下，request.url 的 host 可能是内部地址 0.0.0.0:3000，
  //  会导致 NextResponse.redirect 生成跳到内部地址的绝对 URL）
  const location = resolveSafeNext(request);
  const response = new NextResponse(null, {
    status: 302,
    headers: { Location: location },
  });
  return clearAuthCookies(response);
}
