export const dynamic = "force-dynamic";

import { clearAuthCookies } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

export async function POST() {
  return clearAuthCookies(jsonOk({ ok: true, message: "退出登录成功。" }));
}
