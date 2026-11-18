export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getServerProfileFromCookieStore } from "@/lib/auth/auth";
import { AuthorizeForm } from "./authorize-form";

/**
 * /dsh/authorize?port=XXX&session=YYY
 *
 * DSH 插件在系统浏览器里打开本页。已登录时显示确认按钮，确认后提交到
 * /api/user/dsh/authorize-confirm 颁发兑换码并 303 到 GET /dsh/authorize/success：
 * 成功页展示 8 位兑换码，并提供「前往本机自动接入」把码带到
 * http://127.0.0.1:{port}/callback；若回调失败，用户可复制页面上的码粘贴到 DSH 卡片
 * 完成备用兑换。POST-Redirect-GET 保证刷新成功页不会重复建密钥。未登录则先走 OIDC 登录再回来。
 */
export default async function DshAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ port?: string; session?: string }>;
}) {
  const cookieStore = await cookies();
  const profile = await getServerProfileFromCookieStore(cookieStore);

  const { port, session } = await searchParams;
  const portNum = Number(port);
  if (!port || !/^\d+$/.test(port) || portNum <= 0 || portNum >= 65536) {
    return (
      <div style={{ padding: "40px", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
        <h1>参数无效</h1>
        <p>缺少有效的 port 参数。请从 DSH 插件中点击登录按钮重新发起。</p>
      </div>
    );
  }

  if (!profile) {
    const selfPath = `/dsh/authorize?port=${encodeURIComponent(port)}${session ? `&session=${encodeURIComponent(session)}` : ""}`;
    redirect(`/login?next=${encodeURIComponent(selfPath)}`);
  }

  return <AuthorizeForm port={port} session={session ?? null} username={profile.username} />;
}
