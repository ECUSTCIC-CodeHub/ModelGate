export const dynamic = "force-dynamic";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerProfileFromCookieStore } from "@/lib/auth/auth";
import { resolveSafeNext } from "@/lib/shared/safe-next";
import { AuthorizeForm } from "./authorize-form";

/**
 * /dsh/authorize?port=XXX&session=YYY
 *
 * The DSH plugin opens this URL in the user's system browser. If the user is
 * already logged in (OIDC session cookie), they see a "确认登录到 DSH" button;
 * if not, they're redirected to /login with a `next` param that brings them
 * back here after OIDC login. On confirm, the browser is 302-redirected to
 * http://127.0.0.1:{port}/callback?code={code}, and DSH redeems the code.
 */
export default async function DshAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ port?: string; session?: string }>;
}) {
  const cookieStore = await cookies();
  const profile = await getServerProfileFromCookieStore(cookieStore);

  const { port, session } = await searchParams;

  // Validate port — must be a number 1-65535
  const portNum = Number(port);
  if (!port || !/^\d+$/.test(port) || portNum <= 0 || portNum >= 65536) {
    return (
      <div style={{ padding: "40px", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
        <h1>参数无效</h1>
        <p>缺少有效的 port 参数。请从 DSH 插件中点击登录按钮重新发起。</p>
      </div>
    );
  }

  // Not logged in → redirect to login, then back here
  if (!profile) {
    const requestPath = (await headers()).get("x-request-path");
    const selfPath = `/dsh/authorize?port=${encodeURIComponent(port)}${session ? `&session=${encodeURIComponent(session)}` : ""}`;
    // Build the next param from x-request-path (proxy) or the self path
    const next = requestPath
      ? resolveSafeNext(requestPath)
      : selfPath;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  // Logged in → show confirm page
  return (
    <AuthorizeForm
      port={port}
      session={session ?? null}
      username={profile.username}
    />
  );
}
