export const dynamic = "force-dynamic";

import { jsonOk } from "@/lib/http";

export async function POST() {
  return jsonOk({ ok: true, message: "退出登录成功。" });
}
