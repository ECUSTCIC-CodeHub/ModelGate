export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { gatewayDb } from "@/lib/core/db";
import { parseStoredUtc, toShanghaiDatetimeNoMs } from "@/lib/core/db/datetime";
import { htmlEscape } from "@/lib/core/html";
import { maskKey } from "@/lib/services/dsh-enroll";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{8}$`);
const LOCAL_CALLBACK_PREFIX = "http://127.0.0.1:";

/**
 * 成功页只从库里读事实，URL 里只允许 `code`。
 *
 * 密钥掩码、有效期、回调端口与会话都在 dsh_enrollments 记录里，让浏览器把它们
 * 当查询参数带回来等于把服务端已知的事实交出去再收回来：既可伪造，也会把凭证
 * 写进浏览器历史和 Referer。`code` 查不到、已兑换或已过期都回授权页，页面只
 * 承诺仍然成立的结论。
 */
function parseCode(value: string | undefined): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return CODE_PATTERN.test(upper) ? upper : null;
}

type SuccessView = { code: string; maskedKey: string; expiresText: string; callbackUrl: string };

/**
 * 回调地址由落库的 callback_url 重新拼，不接受外部传进来的整串。
 *
 * 上一版会 `new URL(callback)` 校验、再 `toString()` 输出，解码与序列化之间的
 * 偏差能让越过校验的地址照样进 href。这里只按原串做前缀/端口/路径白名单，
 * code 与 session 自己编码拼进去，不经过 URL 解析。
 */
function buildCallbackUrl(callbackUrl: string | null, code: string, session: string | null): string | null {
  if (!callbackUrl || !callbackUrl.startsWith(LOCAL_CALLBACK_PREFIX)) return null;
  const rest = callbackUrl.slice(LOCAL_CALLBACK_PREFIX.length);
  const end = rest.indexOf("/");
  if (end <= 0) return null;
  const portText = rest.slice(0, end);
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port <= 0 || port >= 65536) return null;
  if (rest.slice(end) !== "/callback") return null;

  const query = new URLSearchParams({ code });
  if (session) query.set("session", session);
  return `${LOCAL_CALLBACK_PREFIX}${port}/callback?${query.toString()}`;
}

async function loadSuccessView(code: string): Promise<SuccessView | null> {
  const row = await gatewayDb.queryOne<{
    code: string;
    key_id: number;
    client_id: string | null;
    callback_url: string | null;
    status: string;
    expires_at: string;
  }>(
    "SELECT code, key_id, client_id, callback_url, status, expires_at FROM dsh_enrollments WHERE code = ?",
    [code],
  );
  if (!row || row.status !== "pending") return null;

  const now = new Date();
  const expiresAt = parseStoredUtc(row.expires_at);
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) return null;

  const callbackUrl = buildCallbackUrl(row.callback_url, code, row.client_id);
  const keyRow = await gatewayDb.queryOne<{ key: string; enabled: number; deleted_at: string | null }>(
    "SELECT `key`, enabled, deleted_at FROM `keys` WHERE id = ?",
    [row.key_id],
  );
  if (!keyRow || keyRow.deleted_at !== null || keyRow.enabled !== 1) return null;

  return { code: row.code, maskedKey: maskKey(keyRow.key), expiresText: toShanghaiDatetimeNoMs(expiresAt), callbackUrl: callbackUrl ?? "" };
}

function htmlAuthorizeSuccess(view: SuccessView): string {
  const { code, maskedKey, expiresText, callbackUrl } = view;
  const jump = callbackUrl
    ? `<a class="jump" href="${htmlEscape(callbackUrl)}" target="_blank" rel="noopener noreferrer">打开本机 DSH，前往自动接入</a>`
    : `<p class="sub">本次授权没有登记可回调的本机地址，请复制下方兑换码到 DSH 插件完成接入。</p>`;
  return (
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权成功</title>` +
    `<style>` +
    `body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5}` +
    `.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center}` +
    `.card{max-width:540px;width:92%;background:#fff;border-radius:16px;padding:40px 36px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}` +
    `h1{font-size:20px;margin:0 0 8px}` +
    `.sub{color:#666;font-size:14px;line-height:1.6;margin:0 0 24px}` +
    `.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;letter-spacing:6px;color:#1f8f55;background:#eefaf2;border:1px solid #cdeedd;border-radius:10px;padding:16px 8px;margin:0 0 14px;user-select:all}` +
    `button.copy{font:inherit;font-size:14px;padding:8px 22px;border:none;border-radius:8px;background:#2f9e63;color:#fff;cursor:pointer;font-weight:500}` +
    `button.copy.done{background:#aaa}` +
    `.jump{display:inline-block;font-size:15px;padding:12px 28px;border-radius:8px;background:#2f9e63;color:#fff;text-decoration:none;font-weight:500;margin:18px 0 14px}` +
    `.meta{color:#999;font-size:12px;margin:0 0 16px}` +
    `.note{color:#555;font-size:13px;line-height:1.7;text-align:left;background:#fafafa;border-radius:10px;padding:12px 14px;margin:0}` +
    `.note b{color:#333}` +
    `</style>` +
    `<div class="wrap"><div class="card">` +
    `<h1>授权成功，兑换码已生成</h1>` +
    `<p class="sub">这是 DSH 自动接入失败时的<b>备用兑换凭据</b>。本页在兑换码有效期内可重新打开。</p>` +
    `<div class="code" id="codeBox">${htmlEscape(code)}</div>` +
    `<button class="copy" id="copyBtn">复制兑换码</button>` +
    `<br>` +
    jump +
    `<p class="meta">密钥：${htmlEscape(maskedKey)} · 有效期至 ${htmlEscape(expiresText)}（5 分钟）</p>` +
    `<p class="note">` +
    `<b>如果自动接入没成功</b>（端口被占用、防火墙拦截、标签页被关等），` +
    `回到本页复制上方 8 位兑换码，粘贴到 DSH 插件的「用兑换码接入」输入框提交即可。` +
    `兑换码一次性，被使用或过期后立即失效。` +
    `</p>` +
    `</div></div>` +
    `<script>` +
    `(function(){var b=document.getElementById("copyBtn"),x=document.getElementById("codeBox");if(!b||!x)return;` +
    `b.addEventListener("click",function(){var s=window.getSelection(),r=document.createRange();r.selectNodeContents(x);s.removeAllRanges();s.addRange(r);` +
    `try{document.execCommand("copy");}catch(e){}` +
    `if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(x.textContent.trim());}` +
    `b.classList.add("done");b.textContent="已复制";` +
    `setTimeout(function(){b.classList.remove("done");b.textContent="复制兑换码";},2000);});})();` +
    `</script>`
  );
}

export default async function DshAuthorizeSuccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const code = parseCode(Array.isArray(raw.code) ? raw.code[0] : raw.code);
  if (!code) redirect("/dsh/authorize");

  let view: SuccessView | null = null;
  try {
    view = await loadSuccessView(code);
  } catch (err) {
    console.error("[dsh] 读取授权成功页失败", err);
  }
  if (!view) redirect("/dsh/authorize");

  return (
    <div
      style={{
        padding: "40px",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      }}
      dangerouslySetInnerHTML={{ __html: htmlAuthorizeSuccess(view) }}
    />
  );
}
