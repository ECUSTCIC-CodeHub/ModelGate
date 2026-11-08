export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureUser } from "@/lib/auth/guards";
import { dbCapacityResponse, jsonError } from "@/lib/core/http";
import { getGatewaySettings } from "@/lib/core/settings";
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

function headerUrl(value: string | null): URL | null {
  const raw = value?.split(",")[0]?.trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

function headerHostname(value: string | null): string | null {
  const hostname = headerUrl(value)?.hostname;
  return hostname ? hostname.replace(/\.$/, "") : null;
}

/**
 * 浏览器发起的确认必须同源，挡掉跨站构造的确认表单。
 *
 * 不能拿 `request.url` 或 `Host` 当基准：standalone 下 `request.url` 的主机是
 * `0.0.0.0:3000`，而 CDN/反代回源时可能把 `Host` 改写成源站域名，两者都不等于
 * 浏览器看到的对外域名，合法确认会被判 403。
 */
async function isSameOrigin(request: Request): Promise<boolean> {
  // Sec-Fetch-Site 由浏览器填写，跨站请求伪造不出来，也不受回源改写影响。
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return true;
  if (fetchSite) return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  const originUrl = headerUrl(origin);
  if (!originUrl) return false;
  const originHostname = originUrl.hostname.replace(/\.$/, "");

  // 没有 Sec-Fetch-Site（非浏览器或老浏览器）时退回比对 Origin：
  // 优先用管理端配置的对外域名，其次才是可能被回源改写的 Host。
  let baseUrl = "";
  try {
    baseUrl = (await getGatewaySettings()).public_base_url;
  } catch (err) {
    console.error("[dsh] 读取 public_base_url 失败", err);
  }
  if (baseUrl) {
    const baseOrigin = /^https?:\/\//i.test(baseUrl) ? headerUrl(baseUrl)?.origin : null;
    if (!baseOrigin) {
      console.warn("[dsh] public_base_url 无法解析，退回 Host 比对", { baseUrl });
    } else if (baseOrigin === originUrl.origin) {
      return true;
    } else {
      console.warn("[dsh] Origin 与 public_base_url 不一致", { origin, baseOrigin });
      return false;
    }
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = request.headers.get("host");
  if (headerHostname(forwardedHost) === originHostname || headerHostname(host) === originHostname) {
    return true;
  }
  console.warn("[dsh] 同源校验失败", { fetchSite, origin, host, forwardedHost, baseUrl });
  return false;
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
  if (!(await isSameOrigin(request))) return htmlError("请求来源不合法", 403);

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
