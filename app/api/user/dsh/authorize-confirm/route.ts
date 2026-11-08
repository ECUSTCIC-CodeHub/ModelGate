import { ensureUser } from "@/lib/auth/guards";
import { jsonError } from "@/lib/core/http";
import { enrollDsh } from "@/lib/services/dsh-enroll";
import { z } from "zod";

/**
 * GET /api/user/dsh/authorize-confirm?port=XXX&session=YYY
 *
 * Called when the user clicks "确认登录到 DSH" on the /dsh/authorize page.
 * Generates a key + redeem code, then 302-redirects the browser to the DSH
 * localhost callback: http://127.0.0.1:{port}/callback?code={code}
 *
 * The browser follows the redirect; DSH receives the code, redeems it for the
 * key via POST /api/user/dsh/redeem, and writes the credential. The key
 * itself never appears in the redirect URL — only the one-time code does.
 */
const QuerySchema = z.object({
  port: z
    .string()
    .regex(/^\d{1,5}$/)
    .refine((v) => {
      const n = Number(v);
      return n > 0 && n < 65536;
    }, "port must be 1-65535"),
  session: z.string().max(128).optional(),
});

export async function GET(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;
  const userId = guard.auth.user.id;

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    port: url.searchParams.get("port") ?? "",
    session: url.searchParams.get("session") ?? undefined,
  });
  if (!parsed.success) {
    return jsonError("参数无效：需要 port（1-65535）", 400);
  }

  const port = parsed.data.port;
  const callbackUrl = `http://127.0.0.1:${port}/callback`;

  try {
    const enrollment = await enrollDsh(userId, {
      reuse: true,
      callbackUrl,
      clientId: parsed.data.session ?? null,
    });

    // 302 redirect to the DSH localhost callback with the code.
    // The key itself is NOT in the URL — DSH will redeem the code separately.
    const redirectUrl = `${callbackUrl}?code=${encodeURIComponent(enrollment.code)}`;
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "颁发密钥失败";
    return jsonError(message, 500);
  }
}
