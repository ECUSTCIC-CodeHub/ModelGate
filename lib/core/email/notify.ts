import { marked } from "marked";
import { gatewayDb } from "@/lib/core/db";
import { sendSmtpMessages, type SmtpMessage, type SmtpServerConfig } from "./smtp";
import {
  getEmailSettings,
  incrementSentCount,
  insertEmailSendLogs,
  getFailedEmailLogs,
  markEmailLogSent,
  listSenders,
  planDelivery,
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
      sent += result.sent;
      failed += result.failed;
      allErrors.push(...result.errors);
      for (let i = 0; i < result.items.length; i += 1) {
        const item = result.items[i];
        const recipient = plan.recipients[i];
        if (!recipient) continue;
        logRows.push({
          announcementId,
          recipientEmail: recipient.email,
          senderId: plan.sender.id,
          status: item.ok ? "sent" : "failed",
          error: item.error ?? "",
        });
      }
      if (result.sent > 0) {
        await incrementSentCount(plan.sender.id, result.sent).catch((err) => {
          console.error(`[ModelGate] 更新发件账号 ${plan.sender.id} 发送计数失败:`, err);
        });
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

export async function sendCompletionReport(summary: AnnouncementEmailSummary, title: string): Promise<void> {
  const settings = await getEmailSettings();
  if (!settings.reportEnabled) return;
  const recipients = parseReportRecipients(settings.reportTo);
  if (recipients.length === 0) return;

  const senders = await listSenders();
  const sender = senders.find((s) => s.enabled);
  if (!sender) {
    console.warn("[ModelGate] 未配置可用发件账号，无法发送公告邮件完成通知。");
    return;
  }

  const lines = [
    `公告《${title}》的邮件通知已处理完毕。`,
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
    subject: `【系统公告】邮件发送完成通知 - ${title}`,
    text,
    html: `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>`,
  };
  const messages = recipients.map((email) => ({ ...base, to: email }));

  const result = await sendSmtpMessages(senderToSmtpConfig(sender), messages);
  if (result.failed > 0) {
    console.error("[ModelGate] 公告邮件完成通知发送失败:", result.errors.join("；"));
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
  const failed = await getFailedEmailLogs(announcementId);
  if (failed.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, skippedMissing: 0, errors: [] };
  }

  const senders = await listSenders();
  const sender = senders.find((s) => s.enabled);
  if (!sender) {
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
  const byAnnouncement = new Map<number, string[]>();
  for (const f of failed) {
    const arr = byAnnouncement.get(f.announcementId) ?? [];
    arr.push(f.recipientEmail);
    byAnnouncement.set(f.announcementId, arr);
  }

  const allEmails = Array.from(new Set(failed.map((f) => f.recipientEmail)));
  const userRows = await gatewayDb.query<{ username: string; email: string }>(
    `SELECT username, email FROM users WHERE email IN (${allEmails.map(() => "?").join(", ")})`,
    allEmails,
  );
  const usernameByEmail = new Map(userRows.map((r) => [r.email, r.username]));

  let attempted = 0;
  let sent = 0;
  let failedCount = 0;
  let skippedMissing = 0;
  const errors: string[] = [];
  const htmlCache = new Map<number, string>();

  for (const [aid, emails] of byAnnouncement) {
    const announcement = await getAnnouncement(aid);
    if (!announcement) {
      skippedMissing += emails.length;
      continue;
    }
    let htmlContent = htmlCache.get(aid);
    if (!htmlContent) {
      htmlContent = await renderMarkdown(announcement.content);
      htmlCache.set(aid, htmlContent);
    }
    const recipients = emails
      .filter((email) => !isEmailDomainBlocked(email, blocked))
      .map((email) => ({
        email,
        username: usernameByEmail.get(email) ?? (email.split("@")[0] || email),
      }));
    if (recipients.length === 0) continue;
    const messages = recipients.map((recipient) =>
      buildMessage(sender, settings, recipient, announcement.title, announcement.content, htmlContent),
    );
    const result = await sendSmtpMessages(senderToSmtpConfig(sender), messages);
    attempted += recipients.length;
    sent += result.sent;
    failedCount += result.failed;
    for (let i = 0; i < result.items.length; i += 1) {
      const item = result.items[i];
      const email = emails[i];
      if (item.ok) {
        await markEmailLogSent(aid, email).catch((err) => {
          console.error(`[ModelGate] 更新邮件日志失败 (${aid}/${email}):`, err);
        });
      } else if (item.error) {
        errors.push(`${email}: ${item.error}`);
      }
    }
  }

  return { attempted, sent, failed: failedCount, skippedMissing, errors: errors.slice(0, 20) };
}
