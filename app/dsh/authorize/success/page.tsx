export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { gatewayDb } from "@/lib/core/db";
import { parseStoredUtc, toShanghaiDatetimeNoMs } from "@/lib/core/db/datetime";
import { maskKey } from "@/lib/services/dsh-enroll";
import { cn } from "@/lib/shared/utils";
import { CopyCode } from "./copy-code";

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
    <AuthShell subtitle="DSH 接入授权" width="wide">
      <Card>
        <CardHeader>
          <CardTitle>授权成功，兑换码已生成</CardTitle>
          <CardDescription>这是 DSH 自动接入失败时的备用兑换凭据。本页在兑换码有效期内可重新打开。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyCode code={view.code} />

          {view.callbackUrl ? (
            <a
              href={view.callbackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants(), "w-full")}
            >
              打开本机 DSH，前往自动接入
            </a>
          ) : (
            <p className="text-sm leading-6 text-[var(--color-foreground-muted)]">
              本次授权没有登记可回调的本机地址，请复制上方兑换码到 DSH 插件完成接入。
            </p>
          )}

          <p className="text-xs leading-5 text-[var(--color-foreground-subtle)]">
            密钥：{view.maskedKey} · 有效期至 {view.expiresText}（5 分钟）
          </p>

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm leading-6 text-[var(--color-foreground-muted)]">
            <strong className="font-medium text-[var(--color-foreground)]">如果自动接入没成功</strong>
            （端口被占用、防火墙拦截、标签页被关等），回到本页复制上方 8 位兑换码，粘贴到 DSH 插件的「用兑换码接入」输入框提交即可。
            兑换码一次性，被使用或过期后立即失效。
          </div>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
