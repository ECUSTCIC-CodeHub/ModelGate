import { marked } from "marked";
import { gatewayDb } from "@/lib/core/db";
import { sendSmtpMessages, type SmtpMessage, type SmtpServerConfig } from "./smtp";
import {
  getEmailSettings,
  incrementSentCount,
  insertEmailSendLogs,
  getFailedEmailLogsForResend,
  markEmailLogSent,
  markBroadcastLogSent,
  listSenders,
  planDelivery,
  getSenderRemainingCapacity,
  parseBlockedDomains,
  type EmailSender,
  type EmailSendLogInput,
} from "./store";

export type AnnouncementEmailSummary = {
  triggered: boolean;
  recipients: number;
  sent: number;
  failed: number;
  skippedNoCapacity: number;
  errors: string[];
};

async function renderMarkdown(content: string): Promise<string> {
  try {
    return (await marked.parse(content, { async: false })) as string;
  } catch {
    return content.replace(/\n/g, "<br/>");
  }
}

function buildSubject(template: string, title: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return template.replace(/\{title\}/g, title).replace(/\{date\}/g, date);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildFailedError(originalErr: string, fallbackErr: string): string {
  if (!originalErr && !fallbackErr) return "所有发件账号额度已用尽，无法发送";
  if (!originalErr) return fallbackErr;
  if (!fallbackErr) return `${originalErr}（所有备选发件账号额度已用尽）`;
  return `${originalErr}（重试后仍失败: ${fallbackErr}）`;
}

function renderFooterText(footer: string): string {
  return footer
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "");
}

function isEmailDomainBlocked(email: string, blocked: string[]): boolean {
  if (blocked.length === 0) return false;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return blocked.includes(domain);
}

let broadcastSendInFlight = false;

export function isBroadcastSending(): boolean {
  return broadcastSendInFlight;
}

let fallbackLock: Promise<void> = Promise.resolve();

function withFallbackLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = fallbackLock.then(() => fn(), () => fn());
  fallbackLock = run.then(() => undefined, () => undefined);
  return run;
}

type FallbackSettings = { fromName: string; subjectTemplate: string; footer: string };

async function sendWithFallback(
  recipient: { email: string; username: string },
  settings: FallbackSettings,
  title: string,
  content: string,
  htmlContent: string,
  candidates: EmailSender[],
  liveRemaining: Map<number, number>,
  opts: { countQuota: boolean; excludeSenderId?: number },
): Promise<{ ok: boolean; senderId: number | null; error: string }> {
  return withFallbackLock(async () => {
  let lastError = "";
  for (const s of candidates) {
    if (opts.excludeSenderId === s.id) continue;
    const rem = liveRemaining.get(s.id) ?? 0;
    if (rem <= 0) continue;
    liveRemaining.set(s.id, rem - 1);
    try {
      const res = await sendSmtpMessages(senderToSmtpConfig(s), [
        buildMessage(s, settings, recipient, title, content, htmlContent),
      ]);
      if (res.sent > 0) {
        if (opts.countQuota) {
          await incrementSentCount(s.id, 1).catch((err) => {
            console.error(`[ModelGate] 更新发件账号 ${s.id} 发送计数失败:`, err);
          });
        }
        return { ok: true, senderId: s.id, error: "" };
      }
      lastError = res.errors[0] ?? "发送失败";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    liveRemaining.set(s.id, (liveRemaining.get(s.id) ?? 0) + 1);
  }
  return { ok: false, senderId: opts.excludeSenderId ?? null, error: lastError };
  });
}

function buildMessage(
  sender: EmailSender,
  settings: { fromName: string; subjectTemplate: string; footer: string },
  recipient: { email: string; username: string },
  title: string,
  content: string,
  htmlContent: string,
): SmtpMessage {
  const fromName = sender.fromName || settings.fromName || undefined;
  const footerHtml = settings.footer
    ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/><p style="color:#6b7280;font-size:12px">${settings.footer}</p>`
    : "";
  const bodyHtml = `${htmlContent}${footerHtml}`;

  const footerText = settings.footer ? `\n\n${renderFooterText(settings.footer)}` : "";
  const text = `尊敬的 ${recipient.username}：\n\n${content}${footerText}`;

  return {
    from: { address: sender.fromAddress, name: fromName },
    to: recipient.email,
    subject: buildSubject(settings.subjectTemplate, title),
    text,
    html: bodyHtml,
  };
}

function senderToSmtpConfig(sender: EmailSender): SmtpServerConfig {
  return {
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth: sender.authUser ? { user: sender.authUser, pass: sender.authPass } : undefined,
  };
}

export async function sendAnnouncementEmails(
  title: string,
  content: string,
  announcementId: number,
): Promise<AnnouncementEmailSummary> {
  const empty: AnnouncementEmailSummary = {
    triggered: false,
    recipients: 0,
    sent: 0,
    failed: 0,
    skippedNoCapacity: 0,
    errors: [],
  };

  const settings = await getEmailSettings();
  if (!settings.enabled) return empty;

  const senders = await listSenders();
  if (senders.length === 0) return empty;

  const blocked = parseBlockedDomains(settings.blockedDomains);
  const rows = await gatewayDb.query<{ username: string; email: string }>(
    `SELECT username, email FROM users
     WHERE deleted_at IS NULL AND enabled = 1 AND email IS NOT NULL AND email != ''`,
  );
  const recipients = rows
    .filter((r) => /.+@.+\..+/.test(r.email))
    .filter((r) => !isEmailDomainBlocked(r.email, blocked))
    .map((r) => ({ email: r.email, username: r.username }));

  if (recipients.length === 0) return { ...empty, triggered: true };

  const candidates = senders
    .filter((s) => s.enabled)
    .sort((a, b) => b.priority - a.priority);
  const liveRemaining = new Map<number, number>();
  for (const s of candidates) liveRemaining.set(s.id, getSenderRemainingCapacity(s));

  const { plans, noCapacity } = planDelivery(senders, recipients);
  if (plans.length === 0) {
    return { ...empty, triggered: true, recipients: recipients.length, skippedNoCapacity: noCapacity };
  }

  const htmlContent = await renderMarkdown(content);

  const allErrors: string[] = [];
  const logRows: EmailSendLogInput[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    plans.map(async (plan) => {
      const messages = plan.recipients.map((recipient) =>
        buildMessage(plan.sender, settings, recipient, title, content, htmlContent),
      );
      const result = await sendSmtpMessages(senderToSmtpConfig(plan.sender), messages);
      if (result.sent > 0) {
        liveRemaining.set(plan.sender.id, (liveRemaining.get(plan.sender.id) ?? 0) - result.sent);
        await incrementSentCount(plan.sender.id, result.sent).catch((err) => {
          console.error(`[ModelGate] 更新发件账号 ${plan.sender.id} 发送计数失败:`, err);
        });
      }
      for (let i = 0; i < result.items.length; i += 1) {
        const item = result.items[i];
        const recipient = plan.recipients[i];
        if (!recipient) continue;
        if (item.ok) {
          sent += 1;
          logRows.push({
            announcementId,
            recipientEmail: recipient.email,
            senderId: plan.sender.id,
            status: "sent",
            error: "",
          });
          continue;
        }
        const fb = await sendWithFallback(
          recipient,
          settings,
          title,
          content,
          htmlContent,
          candidates,
          liveRemaining,
          { countQuota: true, excludeSenderId: plan.sender.id },
        );
        if (fb.ok) {
          sent += 1;
          logRows.push({
            announcementId,
            recipientEmail: recipient.email,
            senderId: fb.senderId!,
            status: "sent",
            error: "",
          });
        } else {
          failed += 1;
          const errMsg = buildFailedError(item.error ?? "", fb.error);
          if (errMsg) allErrors.push(errMsg);
          logRows.push({
            announcementId,
            recipientEmail: recipient.email,
            senderId: plan.sender.id,
            status: "failed",
            error: errMsg,
          });
        }
      }
    }),
  );

  await insertEmailSendLogs(logRows).catch((err) => {
    console.error("[ModelGate] 写入邮件发送日志失败:", err);
  });

  return {
    triggered: true,
    recipients: recipients.length,
    sent,
    failed,
    skippedNoCapacity: noCapacity,
    errors: allErrors.slice(0, 20),
  };
}

function parseReportRecipients(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((e) => /.+@.+\..+/.test(e));
}

export async function sendCompletionReport(
  summary: AnnouncementEmailSummary,
  title: string,
  kind: "announcement" | "broadcast" = "announcement",
): Promise<void> {
  const settings = await getEmailSettings();
  if (!settings.reportEnabled) return;
  const recipients = parseReportRecipients(settings.reportTo);
  if (recipients.length === 0) return;

  const senders = await listSenders();
  const sender = senders.find((s) => s.enabled);
  if (!sender) {
    console.warn("[ModelGate] 未配置可用发件账号，无法发送邮件完成通知。");
    return;
  }

  const subjectPrefix = kind === "broadcast" ? "【广播邮件】发送完成通知" : "【系统公告】邮件发送完成通知";
  const titleLine = kind === "broadcast"
    ? `广播邮件《${title}》已处理完毕。`
    : `公告《${title}》的邮件通知已处理完毕。`;

  const lines = [
    titleLine,
    "",
    `计划通知用户数：${summary.recipients}`,
    `成功发送：${summary.sent}`,
    `发送失败：${summary.failed}`,
    `因额度不足跳过：${summary.skippedNoCapacity}`,
  ];
  if (summary.errors.length > 0) {
    lines.push("", "部分错误：", ...summary.errors.slice(0, 10).map((e) => ` - ${e}`));
  }
  if (summary.failed > 0) {
    lines.push("", "失败邮件可在「邮件通知」设置中点击「重发失败邮件」补发（绕过单日额度）。");
  }
  const text = lines.join("\n");
  const base: Omit<SmtpMessage, "to"> = {
    from: { address: sender.fromAddress, name: sender.fromName || settings.fromName || undefined },
    subject: `${subjectPrefix} - ${title}`,
    text,
    html: `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>`,
  };
  const messages = recipients.map((email) => ({ ...base, to: email }));

  const result = await sendSmtpMessages(senderToSmtpConfig(sender), messages);
  if (result.failed > 0) {
    console.error("[ModelGate] 邮件完成通知发送失败:", result.errors.join("；"));
  }
}

export function notifyAnnouncementAsync(title: string, content: string, announcementId: number): void {
  void sendAnnouncementEmails(title, content, announcementId)
    .then((summary) => sendCompletionReport(summary, title))
    .catch((err) => console.error("[ModelGate] 公告邮件通知失败:", err));
}

async function getAnnouncement(id: number): Promise<{ title: string; content: string } | null> {
  const row = await gatewayDb.queryOne<{ title: string; content: string }>(
    "SELECT title, content FROM announcements WHERE id = ?",
    [id],
  );
  return row ?? null;
}

export type ResendFailedSummary = {
  attempted: number;
  sent: number;
  failed: number;
  skippedMissing: number;
  errors: string[];
};

export async function resendFailedEmails(
  announcementId?: number,
): Promise<ResendFailedSummary> {
  const failed = await getFailedEmailLogsForResend(announcementId);
  if (failed.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, skippedMissing: 0, errors: [] };
  }

  const senders = await listSenders();
  if (senders.length === 0) {
    return {
      attempted: failed.length,
      sent: 0,
      failed: failed.length,
      skippedMissing: 0,
      errors: ["未配置可用发件账号，无法重发失败邮件。"],
    };
  }

  const settings = await getEmailSettings();
  const blocked = parseBlockedDomains(settings.blockedDomains);
  const announcementFailures = failed.filter((f) => f.kind === "announcement");
  const broadcastFailures = failed.filter((f) => f.kind === "broadcast");

  const byAnnouncement = new Map<number, { title: string; content: string; emails: string[] }>();
  for (const f of announcementFailures) {
    const entry = byAnnouncement.get(f.announcementId) ?? { title: "", content: "", emails: [] };
    entry.emails.push(f.recipientEmail);
    byAnnouncement.set(f.announcementId, entry);
  }
  for (const [aid, info] of byAnnouncement) {
    const announcement = await getAnnouncement(aid);
    if (announcement) {
      info.title = announcement.title;
      info.content = announcement.content;
    }
  }

  const allEmails = Array.from(new Set(failed.map((f) => f.recipientEmail)));
  const userRows = await gatewayDb.query<{ username: string; email: string }>(
    `SELECT username, email FROM users WHERE email IN (${allEmails.map(() => "?").join(", ")})`,
    allEmails,
  );
  const usernameByEmail = new Map(userRows.map((r) => [r.email, r.username]));

  const candidates = senders
    .filter((s) => s.enabled)
    .sort((a, b) => b.priority - a.priority);
  const liveRemaining = new Map<number, number>();
  for (const s of candidates) liveRemaining.set(s.id, Number.POSITIVE_INFINITY);

  let attempted = 0;
  let sent = 0;
  let failedCount = 0;
  let skippedMissing = 0;
  const errors: string[] = [];
  const htmlCache = new Map<string, string>();

  for (const [aid, info] of byAnnouncement) {
    if (!info.title) {
      skippedMissing += info.emails.length;
      continue;
    }
    let htmlContent = htmlCache.get(`a:${aid}`);
    if (!htmlContent) {
      htmlContent = await renderMarkdown(info.content);
      htmlCache.set(`a:${aid}`, htmlContent);
    }
    const recipients = info.emails
      .filter((email) => !isEmailDomainBlocked(email, blocked))
      .map((email) => ({
        email,
        username: usernameByEmail.get(email) ?? (email.split("@")[0] || email),
      }));
    if (recipients.length === 0) continue;
    for (const recipient of recipients) {
      attempted += 1;
      const fb = await sendWithFallback(
        recipient,
        settings,
        info.title,
        info.content,
        htmlContent,
        candidates,
        liveRemaining,
        { countQuota: false },
      );
      if (fb.ok) {
        sent += 1;
        await markEmailLogSent(aid, recipient.email).catch((err) => {
          console.error(`[ModelGate] 更新邮件日志失败 (${aid}/${recipient.email}):`, err);
        });
      } else {
        failedCount += 1;
        if (fb.error) errors.push(`${recipient.email}: ${fb.error}`);
      }
    }
  }

  for (const f of broadcastFailures) {
    if (!f.title || !f.content) {
      skippedMissing += 1;
      continue;
    }
    if (isEmailDomainBlocked(f.recipientEmail, blocked)) continue;
    attempted += 1;
    const cacheKey = JSON.stringify(["b", f.title, f.content]);
    let htmlContent = htmlCache.get(cacheKey);
    if (!htmlContent) {
      htmlContent = await renderMarkdown(f.content);
      htmlCache.set(cacheKey, htmlContent);
    }
    const recipient = {
      email: f.recipientEmail,
      username: usernameByEmail.get(f.recipientEmail) ?? (f.recipientEmail.split("@")[0] || f.recipientEmail),
    };
    const fb = await sendWithFallback(
      recipient,
      settings,
      f.title,
      f.content,
      htmlContent,
      candidates,
      liveRemaining,
      { countQuota: false },
    );
    if (fb.ok) {
      sent += 1;
      await markBroadcastLogSent(f.recipientEmail, f.title).catch((err) => {
        console.error(`[ModelGate] 更新广播邮件日志失败 (${f.recipientEmail}):`, err);
      });
    } else {
      failedCount += 1;
      if (fb.error) errors.push(`${recipient.email}: ${fb.error}`);
    }
  }

  return { attempted, sent, failed: failedCount, skippedMissing, errors: errors.slice(0, 20) };
}

export type BroadcastEmailSummary = {
  triggered: boolean;
  recipients: number;
  sent: number;
  failed: number;
  skippedNoCapacity: number;
  errors: string[];
};

export async function sendBroadcastEmail(opts: {
  title: string;
  content: string;
  groupId?: number | null;
}): Promise<BroadcastEmailSummary> {
  const empty: BroadcastEmailSummary = {
    triggered: false,
    recipients: 0,
    sent: 0,
    failed: 0,
    skippedNoCapacity: 0,
    errors: [],
  };

  if (broadcastSendInFlight) {
    return { ...empty, triggered: false, errors: ["已有广播邮件发送任务进行中"] };
  }
  broadcastSendInFlight = true;
  try {
    const settings = await getEmailSettings();
  if (!settings.enabled) return empty;

  const senders = await listSenders();
  if (senders.length === 0) return empty;

  const blocked = parseBlockedDomains(settings.blockedDomains);
  const baseSql =
    `SELECT username, email FROM users
     WHERE deleted_at IS NULL AND enabled = 1 AND email IS NOT NULL AND email != ''`;
  const rows = opts.groupId
    ? await gatewayDb.query<{ username: string; email: string }>(
        `${baseSql} AND group_id = ?`,
        [opts.groupId],
      )
    : await gatewayDb.query<{ username: string; email: string }>(baseSql);
  const recipients = rows
    .filter((r) => /.+@.+\..+/.test(r.email))
    .filter((r) => !isEmailDomainBlocked(r.email, blocked))
    .map((r) => ({ email: r.email, username: r.username }));

  if (recipients.length === 0) return { ...empty, triggered: true };

  const candidates = senders
    .filter((s) => s.enabled)
    .sort((a, b) => b.priority - a.priority);
  const liveRemaining = new Map<number, number>();
  for (const s of candidates) liveRemaining.set(s.id, getSenderRemainingCapacity(s));

  const { plans, noCapacity } = planDelivery(senders, recipients);
  if (plans.length === 0) {
    return { ...empty, triggered: true, recipients: recipients.length, skippedNoCapacity: noCapacity };
  }

  const htmlContent = await renderMarkdown(opts.content);

  const allErrors: string[] = [];
  const logRows: EmailSendLogInput[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    plans.map(async (plan) => {
      const messages = plan.recipients.map((recipient) =>
        buildMessage(plan.sender, settings, recipient, opts.title, opts.content, htmlContent),
      );
      const result = await sendSmtpMessages(senderToSmtpConfig(plan.sender), messages);
      if (result.sent > 0) {
        liveRemaining.set(plan.sender.id, (liveRemaining.get(plan.sender.id) ?? 0) - result.sent);
        await incrementSentCount(plan.sender.id, result.sent).catch((err) => {
          console.error(`[ModelGate] 更新发件账号 ${plan.sender.id} 发送计数失败:`, err);
        });
      }
      for (let i = 0; i < result.items.length; i += 1) {
        const item = result.items[i];
        const recipient = plan.recipients[i];
        if (!recipient) continue;
        if (item.ok) {
          sent += 1;
          logRows.push({
            announcementId: 0,
            recipientEmail: recipient.email,
            senderId: plan.sender.id,
            status: "sent",
            error: "",
            kind: "broadcast",
            title: opts.title,
            content: opts.content,
          });
          continue;
        }
        const fb = await sendWithFallback(
          recipient,
          settings,
          opts.title,
          opts.content,
          htmlContent,
          candidates,
          liveRemaining,
          { countQuota: true, excludeSenderId: plan.sender.id },
        );
        if (fb.ok) {
          sent += 1;
          logRows.push({
            announcementId: 0,
            recipientEmail: recipient.email,
            senderId: fb.senderId!,
            status: "sent",
            error: "",
            kind: "broadcast",
            title: opts.title,
            content: opts.content,
          });
        } else {
          failed += 1;
          const errMsg = buildFailedError(item.error ?? "", fb.error);
          if (errMsg) allErrors.push(errMsg);
          logRows.push({
            announcementId: 0,
            recipientEmail: recipient.email,
            senderId: plan.sender.id,
            status: "failed",
            error: errMsg,
            kind: "broadcast",
            title: opts.title,
            content: opts.content,
          });
        }
      }
    }),
  );

  await insertEmailSendLogs(logRows).catch((err) => {
    console.error("[ModelGate] 写入广播邮件发送日志失败:", err);
  });

  return {
    triggered: true,
    recipients: recipients.length,
    sent,
    failed,
    skippedNoCapacity: noCapacity,
    errors: allErrors.slice(0, 20),
  };
  } finally {
    broadcastSendInFlight = false;
  }
}

export function notifyBroadcastAsync(opts: {
  title: string;
  content: string;
  groupId?: number | null;
}): void {
  void sendBroadcastEmail(opts)
    .then((summary) => sendCompletionReport(summary, opts.title, "broadcast"))
    .catch((err) => console.error("[ModelGate] 广播邮件发送失败:", err));
}
