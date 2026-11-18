export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureUserWithRefresh } from "@/lib/auth/guards";
import { authPageHtml } from "@/lib/core/auth-page";
import { dbCapacityResponse, jsonError } from "@/lib/core/http";
import { getGatewaySettings } from "@/lib/core/settings";
import { enrollDsh } from "@/lib/services/dsh-enroll";

/**
 * POST /api/user/dsh/authorize-confirm  (表单：port, session?)
 *
 * /dsh/authorize 的「确认登录」由同源 HTML 表单提交到这里。颁发一枚 DSH
 * 专用密钥 + 一次性兑换码，然后 303 到 GET /dsh/authorize/success：成功页展示
 * 8 位兑换码供抄录，并提供「前往本机 DSH 自动接入」链接把码带回
 * http://127.0.0.1:{port}/callback。
 *
 * 不在确认时直接 303 跳本机回调：OIDC 主路径一旦失败（回调端口被占、防火墙拦截、
 * 浏览器标签被关等），用户需要在浏览器里拿到码做备用兑换。POST 改 303 到 GET
 * 成功页，既保留展示码的能力，又让刷新只重拉 GET，不会重复建密钥。
 *
 * 明文密钥不出现在跳转地址里，DSH 拿到码后自己调 /api/user/dsh/redeem 换取。
 * 必须用 POST：每次确认都会新建密钥，不是幂等读取，不能挂在 GET 上。
 * 成功页地址只带兑换码：密钥掩码、有效期、回调端口与会话都由成功页按码回查，
 * 这些事实不进 Location，免得写进浏览器历史和跨站 Referer。
 */

const ConfirmSchema = z.object({
  port: z
    .string()
    .regex(/^\d{1,5}$/)
    .refine((v) => {
      const n = Number(v);
      return n > 0 && n < 65536;
    }),
  // 会话标识只用来让插件认领自己发起的那次回调，字符集必须窄：它要过表单编码、
  // 查询串编码和 HTML 转义三道手，含 & + % 的值会在链路里漂移，插件比对上就丢了。
  session: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
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

/**
 * 错误页的页脚动作按原因分开：参数/来源问题要用户重新发起，服务繁忙只是等一会儿。
 * 混用会让同一张卡片里「稍后重试」和「重新发起登录」互相打架。
 */
const ERROR_FOOTERS = {
  retry: "请回到 DSH 插件重新发起登录。",
  busy: "稍等片刻后回到 DSH 插件重试即可，本次没有创建任何密钥。",
} as const;

async function htmlError(message: string, status: number, footer: string = ERROR_FOOTERS.retry, theme = true) {
  const body = await authPageHtml({
    title: "授权失败",
    heading: "授权失败",
    message,
    footer,
    theme,
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function htmlBusy(retryAfter: string | null) {
  // 走到这里说明数据库已经饱和，主题色那一次读库也跳过，先把 503 送出去。
  const response = await htmlError("服务繁忙，请稍后重试", 503, ERROR_FOOTERS.busy, false);
  if (retryAfter) response.headers.set("retry-after", retryAfter);
  return response;
}

// 未登录时浏览器已经跳过一次 401 JSON 了：这里 303 回登录页，把授权页（含 port /
// session）留在 next 里，登录完还能回到同一张确认页。
function loginPath(request: Request): string {
  const referer = request.headers.get("referer");
  let next = "/dsh/authorize";
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.pathname.replace(/\/$/, "") === "/dsh/authorize") next = `/dsh/authorize${url.search}`;
    } catch {
      // referer 不可解析时用默认值
    }
  }
  return `/login?next=${encodeURIComponent(next)}`;
}

export async function POST(request: Request) {
  const guard = await ensureUserWithRefresh(request);
  if ("error" in guard) {
    if (guard.error.status === 401) {
      return new Response(null, { status: 303, headers: { location: loginPath(request), "cache-control": "no-store" } });
    }
    if (guard.error.status === 503) return htmlBusy(guard.error.headers.get("retry-after"));
    return guard.error;
  }
  // 同源校验只挡浏览器发起的跨站表单；非浏览器客户端可自行构造 Sec-Fetch-Site / Origin，
  // 所以这里真正的门槛是上面 ensureUserWithRefresh 拒绝 API Key
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
  if (!parsed.success) return htmlError("参数无效：需要 port（1-65535），session 仅允许字母数字与 . _ -", 400);

  const { port, session } = parsed.data;
  const callbackUrl = `http://127.0.0.1:${port}/callback`;

  try {
    const result = await enrollDsh(guard.auth.user.id, {
      callbackUrl,
      clientId: session ?? null,
    });
    if (!result.ok) return htmlError(FAILURE_MESSAGES[result.reason], 400);

    // PRG：POST 只建一次密钥和兑换码，随后 303 到 GET 成功页。浏览器地址栏停在
    // GET 地址，刷新不会重放创建动作。Location 里只放兑换码，回调地址与会话按码
    // 回查，不在跳转地址上重复声明服务端已经记下的事实。
    const successParams = new URLSearchParams({ code: result.enrollment.code });
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/dsh/authorize/success?${successParams.toString()}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (err) {
    const busy = dbCapacityResponse(err);
    if (busy) return htmlBusy(busy.headers.get("retry-after"));
    console.error("[dsh] 授权确认失败", err);
    return htmlError("授权失败，请稍后重试", 500);
  }
}

export async function GET() {
  return jsonError("请从授权确认页提交", 405, {}, { allow: "POST" });
}
