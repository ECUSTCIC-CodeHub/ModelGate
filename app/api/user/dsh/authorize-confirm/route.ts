export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureUser } from "@/lib/auth/guards";
import { dbCapacityResponse, jsonError } from "@/lib/core/http";
import { enrollDsh } from "@/lib/services/dsh-enroll";

/**
 * POST /api/user/dsh/authorize-confirm  (表单：port, session?)
 *
 * /dsh/authorize 的「确认登录」由同源 HTML 表单提交到这里。颁发一枚 DSH
 * 专用密钥 + 一次性兑换码，然后 303 跳回 http://127.0.0.1:{port}/callback?code=xxx。
 * 明文密钥不出现在跳转地址里，DSH 拿到码后自己调 /api/user/dsh/redeem 换取。
 * 必须用 POST：每次确认都会新建密钥，不是幂等读取，不能挂在 GET 上。
 */

const ConfirmSchema = z.object({
  port: z
    .string()
    .regex(/^\d{1,5}$/)
    .refine((v) => {
      const n = Number(v);
      return n > 0 && n < 65536;
    }),
  session: z.string().max(128).optional(),
});

const FAILURE_MESSAGES = {
  key_limit: "密钥数量已达上限，请先删除不用的密钥",
  enroll_limit: "待兑换的授权码过多，请稍后再试",
  code_conflict: "授权码生成失败，请重试",
} as const;

/** 浏览器发起的确认必须同源，挡掉跨站构造的确认表单。 */
function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function htmlError(message: string, status: number) {
  const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>授权失败</title>` +
      `<div style="padding:40px;text-align:center;font-family:system-ui,sans-serif">` +
      `<h1 style="font-size:20px">授权失败</h1><p style="color:#666">${safe}</p></div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;
  if (!isSameOrigin(request)) return htmlError("请求来源不合法", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return htmlError("请求格式不正确", 400);
  }

  const parsed = ConfirmSchema.safeParse({
    port: String(form.get("port") ?? ""),
    session: form.get("session") ? String(form.get("session")) : undefined,
  });
  if (!parsed.success) return htmlError("参数无效：需要 port（1-65535）", 400);

  const { port, session } = parsed.data;
  const callbackUrl = `http://127.0.0.1:${port}/callback`;

  try {
    const result = await enrollDsh(guard.auth.user.id, {
      callbackUrl,
      clientId: session ?? null,
    });
    if (!result.ok) return htmlError(FAILURE_MESSAGES[result.reason], 400);

    // session 交由 DSH 自己比对：浏览器跳回来时带上它，插件只认自己发起的那个会话
    const query = new URLSearchParams({ code: result.enrollment.code });
    if (session) query.set("session", session);

    return new Response(null, {
      status: 303,
      headers: {
        Location: `${callbackUrl}?${query.toString()}`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return busy;
    console.error("[dsh] 授权确认失败", err);
    return htmlError("授权失败，请稍后重试", 500);
  }
}

export async function GET() {
  return jsonError("请从授权确认页提交", 405, {}, { allow: "POST" });
}
