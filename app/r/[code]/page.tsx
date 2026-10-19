import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getServerProfileFromCookieStore } from "@/lib/auth/auth";

export const dynamic = "force-dynamic";

// 扫码落地页的唯一决策逻辑：已登录直接带码进兑换页，未登录先登录并在 next 里保留本路径。
// 空值分支可达输入是 URL 编码的纯空白码（/r/%20 解码后 trim 为空）；字面空串在路由层不可达（/r/ 会 308 到 /r 再 404），这里一并兜底。
export function deepLinkTarget(profilePresent: boolean, code: string): string {
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 64) return "/dashboard/redeem";
  if (profilePresent) return `/dashboard/redeem?code=${encodeURIComponent(trimmed)}`;
  return `/login?next=${encodeURIComponent(`/r/${trimmed}`)}`;
}

export default async function RedeemDeepLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const profile = await getServerProfileFromCookieStore(await cookies());
  redirect(deepLinkTarget(!!profile, code));
}
