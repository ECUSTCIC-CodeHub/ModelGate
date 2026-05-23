export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { clearAuthCookies } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

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
  return clearAuthCookies(NextResponse.redirect(new URL(resolveSafeNext(request), request.url), 302));
}
