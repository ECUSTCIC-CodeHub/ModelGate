import { gatewayDb } from "@/lib/core/db";
import { toMysqlDatetime } from "@/lib/core/db/datetime";
import { decryptPassword, encryptPassword } from "./crypto";

export type EmailSettings = {
  enabled: boolean;
  subjectTemplate: string;
  fromName: string;
  footer: string;
  reportEnabled: boolean;
  reportTo: string;
  blockedDomains: string;
};

export type EmailSender = {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  authUser: string;
  authPass: string;
  fromAddress: string;
  fromName: string;
  dailyLimit: number;
  priority: number;
  enabled: boolean;
  sentToday: number;
  sentDate: string;
};

export type EmailSenderInput = {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  authUser: string;
  authPass: string;
  fromAddress: string;
  fromName: string;
  dailyLimit: number;
  priority: number;
  enabled: boolean;
};

const PASSWORD_MASK = "••••••••";

const EMAIL_SETTINGS_KEYS = [
  "email_notifications_enabled",
  "email_subject_template",
  "email_from_name",
  "email_footer",
  "email_report_enabled",
  "email_report_to",
  "email_blocked_domains",
] as const;

const DEFAULT_SUBJECT_TEMPLATE = "【系统公告】{title}";

export function parseBlockedDomains(value: string): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(/[,;\s]+/)
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0 && d.includes(".")),
    ),
  );
}

export function normalizeBlockedDomains(value: string): string {
  return parseBlockedDomains(value).join(", ");
}

function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getEmailSettings(): Promise<EmailSettings> {
  const rows = await gatewayDb.query<{ key: string; value: string }>(
    `SELECT \`key\`, value FROM settings WHERE \`key\` IN (${EMAIL_SETTINGS_KEYS.map(() => "?").join(", ")})`,
    [...EMAIL_SETTINGS_KEYS],
  );
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    enabled: map.get("email_notifications_enabled") === "1",
    subjectTemplate: map.get("email_subject_template")?.trim() || DEFAULT_SUBJECT_TEMPLATE,
    fromName: map.get("email_from_name") ?? "",
    footer: map.get("email_footer") ?? "",
    reportEnabled: map.get("email_report_enabled") === "1",
    reportTo: map.get("email_report_to") ?? "",
    blockedDomains: map.get("email_blocked_domains") ?? "",
  };
}

export async function setEmailSettings(input: Partial<EmailSettings>): Promise<EmailSettings> {
  const values: Record<string, string> = {};
  if (input.enabled !== undefined) values.email_notifications_enabled = input.enabled ? "1" : "0";
  if (input.subjectTemplate !== undefined) values.email_subject_template = input.subjectTemplate.trim() || DEFAULT_SUBJECT_TEMPLATE;
  if (input.fromName !== undefined) values.email_from_name = input.fromName.trim();
  if (input.footer !== undefined) values.email_footer = input.footer;
  if (input.reportEnabled !== undefined) values.email_report_enabled = input.reportEnabled ? "1" : "0";
  if (input.reportTo !== undefined) values.email_report_to = input.reportTo.trim();
  if (input.blockedDomains !== undefined) values.email_blocked_domains = normalizeBlockedDomains(input.blockedDomains);

  const isMysql = (await gatewayDb.getDriver()) === "mysql";
  const upsertSql = isMysql
    ? `INSERT INTO settings (\`key\`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP`
    : `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`;

  await gatewayDb.transaction(async (tx) => {
    for (const [key, val] of Object.entries(values)) {
      await tx.execute(upsertSql, [key, val]);
    }
  });

  return getEmailSettings();
}

function mapSenderRow(row: Record<string, unknown>): EmailSender {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    host: String(row.host ?? ""),
    port: Number(row.port ?? 25),
    secure: Number(row.secure ?? 0) === 1,
    authUser: String(row.auth_user ?? ""),
    authPass: decryptPassword(String(row.auth_pass ?? "")),
    fromAddress: String(row.from_address ?? ""),
    fromName: String(row.from_name ?? ""),
    dailyLimit: Number(row.daily_limit ?? 0),
    priority: Number(row.priority ?? 0),
    enabled: Number(row.enabled ?? 1) === 1,
    sentToday: Number(row.sent_today ?? 0),
    sentDate: String(row.sent_date ?? ""),
  };
}

export async function listSenders(): Promise<EmailSender[]> {
  const rows = await gatewayDb.query<Record<string, unknown>>(
    `SELECT id, name, host, port, secure, auth_user, auth_pass, from_address, from_name,
            daily_limit, priority, enabled, sent_today, sent_date
     FROM email_senders
     ORDER BY priority DESC, id ASC`,
  );
  return rows.map(mapSenderRow);
}

export async function getSender(id: number): Promise<EmailSender | null> {
  const row = await gatewayDb.queryOne<Record<string, unknown>>(
    `SELECT id, name, host, port, secure, auth_user, auth_pass, from_address, from_name,
            daily_limit, priority, enabled, sent_today, sent_date
     FROM email_senders WHERE id = ?`,
    [id],
  );
  return row ? mapSenderRow(row) : null;
}

function normalizeSenderInput(input: EmailSenderInput, keepPass: string | null) {
  return {
    name: input.name.trim(),
    host: input.host.trim(),
    port: Math.max(1, Math.min(65535, Math.trunc(input.port) || 25)),
    secure: input.secure ? 1 : 0,
    auth_user: input.authUser.trim(),
    auth_pass: encryptPassword(keepPass ?? ""),
    from_address: input.fromAddress.trim(),
    from_name: input.fromName.trim(),
    daily_limit: Math.max(0, Math.trunc(input.dailyLimit)),
    priority: Math.trunc(input.priority),
    enabled: input.enabled ? 1 : 0,
  };
}

export async function createSender(input: EmailSenderInput): Promise<EmailSender> {
  const cols = normalizeSenderInput(input, input.authPass);
  const result = await gatewayDb.execute(
    `INSERT INTO email_senders (
       name, host, port, secure, auth_user, auth_pass, from_address, from_name,
       daily_limit, priority, enabled, sent_today, sent_date
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')`,
    [
      cols.name,
      cols.host,
      cols.port,
      cols.secure,
      cols.auth_user,
      cols.auth_pass,
      cols.from_address,
      cols.from_name,
      cols.daily_limit,
      cols.priority,
      cols.enabled,
    ],
  );
  return (await getSender(Number(result.lastInsertRowid)))!;
}

export async function updateSender(id: number, input: EmailSenderInput): Promise<EmailSender | null> {
  const existing = await getSender(id);
  if (!existing) return null;
  const keepPass = input.authPass === PASSWORD_MASK || input.authPass === "" ? existing.authPass : input.authPass;
  const cols = normalizeSenderInput(input, keepPass);
  await gatewayDb.execute(
    `UPDATE email_senders SET
       name = ?, host = ?, port = ?, secure = ?, auth_user = ?, auth_pass = ?,
       from_address = ?, from_name = ?, daily_limit = ?, priority = ?, enabled = ?
     WHERE id = ?`,
    [
      cols.name,
      cols.host,
      cols.port,
      cols.secure,
      cols.auth_user,
      cols.auth_pass,
      cols.from_address,
      cols.from_name,
      cols.daily_limit,
      cols.priority,
      cols.enabled,
      id,
    ],
  );
  return getSender(id);
}

export async function deleteSender(id: number): Promise<boolean> {
  const result = await gatewayDb.execute("DELETE FROM email_senders WHERE id = ?", [id]);
  return result.changes > 0;
}

export type SenderPlan = {
  sender: EmailSender;
  recipients: Array<{ email: string; username: string }>;
};

function remainingCapacity(sender: EmailSender, today: string): number {
  if (sender.dailyLimit <= 0) return Number.POSITIVE_INFINITY;
  const base = sender.sentDate === today ? sender.sentToday : 0;
  return Math.max(0, sender.dailyLimit - base);
}

function compareRemaining(a: number, b: number): number {
  const aInf = !Number.isFinite(a);
  const bInf = !Number.isFinite(b);
  if (aInf && bInf) return 0;
  if (aInf) return -1;
  if (bInf) return 1;
  return b - a;
}

export function planDelivery(
  senders: EmailSender[],
  recipients: Array<{ email: string; username: string }>,
): { plans: SenderPlan[]; noCapacity: number } {
  const today = todayDateString();
  const queue = senders
    .filter((s) => s.enabled)
    .map((sender) => ({ sender, remaining: remainingCapacity(sender, today) }))
    .sort((a, b) => b.sender.priority - a.sender.priority || compareRemaining(a.remaining, b.remaining));

  const plans: SenderPlan[] = queue.map(({ sender }) => ({ sender, recipients: [] }));
  const planBySender = new Map(plans.map((p) => [p.sender.id, p]));

  let cursor = 0;
  let noCapacity = 0;
  for (const recipient of recipients) {
    let chosen: (typeof queue)[number] | null = null;
    let chosenIdx = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const idx = (cursor + i) % queue.length;
      if (queue[idx].remaining > 0) {
        chosen = queue[idx];
        chosenIdx = idx;
        break;
      }
    }
    if (!chosen) {
      noCapacity += 1;
      continue;
    }
    planBySender.get(chosen.sender.id)!.recipients.push(recipient);
    chosen.remaining -= 1;
    cursor = (chosenIdx + 1) % queue.length;
  }

  return { plans: plans.filter((p) => p.recipients.length > 0), noCapacity };
}

export async function incrementSentCount(senderId: number, count: number): Promise<void> {
  if (count <= 0) return;
  const today = todayDateString();
  await gatewayDb.execute(
    `UPDATE email_senders
     SET sent_today = CASE WHEN sent_date = ? THEN sent_today + ? ELSE ? END,
         sent_date = ?
     WHERE id = ?`,
    [today, count, count, today, senderId],
  );
}

export type EmailSendLogInput = {
  announcementId: number;
  recipientEmail: string;
  senderId: number | null;
  status: "sent" | "failed";
  error: string;
};

export async function insertEmailSendLogs(rows: EmailSendLogInput[]): Promise<void> {
  if (rows.length === 0) return;
  const now = toMysqlDatetime(new Date());
  const sql =
    `INSERT INTO email_send_log (announcement_id, recipient_email, sender_id, status, error, created_at) ` +
    `VALUES (?, ?, ?, ?, ?, ?)`;
  await gatewayDb.transaction(async (tx) => {
    for (const r of rows) {
      await tx.execute(sql, [r.announcementId, r.recipientEmail, r.senderId, r.status, r.error, now]);
    }
  });
}

export async function getFailedEmailLogs(
  announcementId?: number,
): Promise<Array<{ announcementId: number; recipientEmail: string }>> {
  const rows = announcementId !== undefined
    ? await gatewayDb.query<{ announcement_id: number; recipient_email: string }>(
        `SELECT DISTINCT announcement_id, recipient_email
         FROM email_send_log WHERE status = 'failed' AND announcement_id = ?`,
        [announcementId],
      )
    : await gatewayDb.query<{ announcement_id: number; recipient_email: string }>(
        `SELECT DISTINCT announcement_id, recipient_email FROM email_send_log WHERE status = 'failed'`,
      );
  return rows.map((r) => ({ announcementId: Number(r.announcement_id), recipientEmail: r.recipient_email }));
}

export async function markEmailLogSent(announcementId: number, recipientEmail: string): Promise<void> {
  await gatewayDb.execute(
    `UPDATE email_send_log SET status = 'sent', error = '' WHERE announcement_id = ? AND recipient_email = ? AND status = 'failed'`,
    [announcementId, recipientEmail],
  );
}

export type EmailSendLogRow = {
  id: number;
  announcementId: number;
  announcementTitle: string | null;
  recipientEmail: string;
  senderId: number | null;
  status: "sent" | "failed";
  error: string;
  createdAt: string;
};

export async function listEmailSendLogs(
  status?: "sent" | "failed",
): Promise<EmailSendLogRow[]> {
  const rows = status !== undefined
    ? await gatewayDb.query<Record<string, unknown>>(
        `SELECT l.id, l.announcement_id, a.title AS announcement_title, l.recipient_email,
                l.sender_id, l.status, l.error, l.created_at
         FROM email_send_log l
         LEFT JOIN announcements a ON a.id = l.announcement_id
         WHERE l.status = ?
         ORDER BY l.created_at DESC, l.id DESC`,
        [status],
      )
    : await gatewayDb.query<Record<string, unknown>>(
        `SELECT l.id, l.announcement_id, a.title AS announcement_title, l.recipient_email,
                l.sender_id, l.status, l.error, l.created_at
         FROM email_send_log l
         LEFT JOIN announcements a ON a.id = l.announcement_id
         ORDER BY l.created_at DESC, l.id DESC`,
      );
  return rows.map((r) => ({
    id: Number(r.id),
    announcementId: Number(r.announcement_id),
    announcementTitle: r.announcement_title == null ? null : String(r.announcement_title),
    recipientEmail: String(r.recipient_email),
    senderId: r.sender_id == null ? null : Number(r.sender_id),
    status: String(r.status) as "sent" | "failed",
    error: String(r.error ?? ""),
    createdAt: String(r.created_at),
  }));
}
