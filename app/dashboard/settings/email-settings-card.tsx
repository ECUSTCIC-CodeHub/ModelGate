"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch } from "@/lib/auth/client-auth";
import { ToggleRow } from "./settings-card-utils";

type EmailSendLogRow = {
  id: number;
  announcementId: number;
  announcementTitle: string | null;
  recipientEmail: string;
  senderId: number | null;
  status: "sent" | "failed";
  error: string;
  createdAt: string;
};
import {
  EmailSenderDialog,
  PASSWORD_MASK,
  initialSenderForm,
  type SenderForm,
} from "./email-sender-dialog";

type EmailSettingsForm = {
  enabled: boolean;
  subject_template: string;
  from_name: string;
  footer: string;
  report_enabled: boolean;
  report_to: string;
  blocked_domains: string;
};

type SenderRow = SenderForm & {
  id: number;
  auth_pass: string;
  sent_today: number;
  sent_date: string;
};

export function EmailSettingsCard() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<EmailSettingsForm>({
    enabled: false,
    subject_template: "【系统公告】{title}",
    from_name: "",
    footer: "",
    report_enabled: false,
    report_to: "",
    blocked_domains: "",
  });
  const [senders, setSenders] = useState<SenderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SenderRow | null>(null);
  const [dialogInitial, setDialogInitial] = useState<SenderForm>(initialSenderForm);
  const [editorKey, setEditorKey] = useState(0);
  const [savingSender, setSavingSender] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [resending, setResending] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<EmailSendLogRow[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logError, setLogError] = useState("");

  const loadData = useCallback(async () => {
    const [sRes, lRes] = await Promise.all([
      authedFetch("/api/admin/email/settings"),
      authedFetch("/api/admin/email/senders"),
    ]);
    let nextSettings: EmailSettingsForm = {
      enabled: false,
      subject_template: "【系统公告】{title}",
      from_name: "",
      footer: "",
      report_enabled: false,
      report_to: "",
      blocked_domains: "",
    };
    if (sRes.ok) {
      const data = await sRes.json();
      const d = data?.data ?? {};
      nextSettings = {
        enabled: d.enabled === true,
        subject_template: d.subject_template || "【系统公告】{title}",
        from_name: d.from_name || "",
        footer: d.footer || "",
        report_enabled: d.report_enabled === true,
        report_to: d.report_to || "",
        blocked_domains: d.blocked_domains || "",
      };
    }
    let nextSenders: SenderRow[] = [];
    if (lRes.ok) {
      const data = await lRes.json();
      nextSenders = (data?.data ?? []) as SenderRow[];
    }
    return { nextSettings, nextSenders };
  }, []);

  const refresh = useCallback(async () => {
    const { nextSettings, nextSenders } = await loadData();
    setSettings(nextSettings);
    setSenders(nextSenders);
    setLoading(false);
  }, [loadData]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { nextSettings, nextSenders } = await loadData();
      if (cancelled) return;
      setSettings(nextSettings);
      setSenders(nextSenders);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadData]);

  async function saveSettingsNow() {
    setSavingSettings(true);
    try {
      const response = await authedFetch("/api/admin/email/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        const d = data?.data ?? {};
        setSettings({
          enabled: d.enabled === true,
          subject_template: d.subject_template || "【系统公告】{title}",
          from_name: d.from_name || "",
          footer: d.footer || "",
          report_enabled: d.report_enabled === true,
          report_to: d.report_to || "",
          blocked_domains: d.blocked_domains || "",
        });
        toast({ variant: "success", description: getApiMessage(data, "保存成功。") });
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "保存失败。") });
    } finally {
      setSavingSettings(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setDialogInitial(initialSenderForm);
    setEditorKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(sender: SenderRow) {
    setEditing(sender);
    setDialogInitial({
      name: sender.name,
      host: sender.host,
      port: sender.port,
      secure: sender.secure,
      auth_user: sender.auth_user,
      auth_pass: sender.auth_pass || PASSWORD_MASK,
      from_address: sender.from_address,
      from_name: sender.from_name,
      daily_limit: sender.daily_limit,
      priority: sender.priority,
      enabled: sender.enabled,
    });
    setEditorKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function saveSender(form: SenderForm) {
    setSavingSender(true);
    try {
      const url = editing ? `/api/admin/email/senders/${editing.id}` : "/api/admin/email/senders";
      const method = editing ? "PUT" : "POST";
      const response = await authedFetch(url, { method, body: JSON.stringify(form) });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "保存成功。") });
        setDialogOpen(false);
        await refresh();
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "保存失败。") });
    } finally {
      setSavingSender(false);
    }
  }

  async function removeSender(sender: SenderRow) {
    if (!window.confirm(`确认删除发件账号「${sender.name}」？`)) return;
    const response = await authedFetch(`/api/admin/email/senders/${sender.id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除成功。") });
      await refresh();
    } else {
      toast({ variant: "error", description: getApiMessage(data, "删除失败。") });
    }
  }

  async function testSender(sender: SenderRow) {
    const to = window.prompt("测试收件邮箱（留空则发送至发件地址）", sender.from_address);
    if (to === null) return;
    setTestingId(sender.id);
    try {
      const response = await authedFetch(`/api/admin/email/senders/${sender.id}/test`, {
        method: "POST",
        body: JSON.stringify({ to: to.trim() }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "测试邮件已发送。") });
      } else {
        toast({ variant: "error", description: getApiMessage(data, "发送失败。") });
      }
    } finally {
      setTestingId(null);
    }
  }

  function patchSetting(p: Partial<EmailSettingsForm>) {
    setSettings((prev) => ({ ...prev, ...p }));
  }

  async function resendFailed() {
    if (!window.confirm("将向此前发送失败的用户补发公告邮件（绕过单日额度）。是否继续？")) return;
    setResending(true);
    try {
      const response = await authedFetch("/api/admin/email/resend-failed", {
        method: "POST",
        body: "{}",
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "重发完成。") });
      } else {
        toast({ variant: "error", description: getApiMessage(data, "重发失败。") });
      }
    } finally {
      setResending(false);
    }
  }

  async function openLogs() {
    setLogOpen(true);
    setLoadingLogs(true);
    setLogError("");
    try {
      const response = await authedFetch("/api/admin/email/failed-logs?status=failed");
      const data = await response.json().catch(() => null);
      if (response.ok) {
        setLogs((data?.data ?? []) as EmailSendLogRow[]);
      } else {
        setLogError(getApiMessage(data, "获取失败明细失败。"));
      }
    } catch {
      setLogError("获取失败明细失败。");
    } finally {
      setLoadingLogs(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="邮件通知"
          description="配置 SMTP 发件账号，在创建或修改系统公告时向有邮箱的用户发送通知邮件。支持多个账号，优先使用高优先级账号，高优先级达到单日上限后再降级到低优先级。"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow
          title="启用邮件通知"
          description="开启后在发送/修改系统公告时可一并邮件通知用户。"
          checked={settings.enabled}
          onCheckedChange={(v) => patchSetting({ enabled: v })}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>邮件标题模板</Label>
            <Input
              placeholder="【系统公告】{title}"
              value={settings.subject_template}
              onChange={(e) => patchSetting({ subject_template: e.target.value })}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">支持占位符 {"{title}"}（公告标题）与 {"{date}"}（日期）。</p>
          </div>
          <div className="space-y-2">
            <Label>默认发件名称</Label>
            <Input
              placeholder="留空则使用账号的发件名称"
              value={settings.from_name}
              onChange={(e) => patchSetting({ from_name: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>邮件正文页脚</Label>
          <textarea
            className="flex min-h-20 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
            placeholder="可选，附加在邮件末尾的署名或说明"
            value={settings.footer}
            onChange={(e) => patchSetting({ footer: e.target.value })}
            maxLength={2000}
          />
        </div>

        <div className="space-y-2">
          <Label>屏蔽邮箱域名</Label>
          <textarea
            className="flex min-h-16 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
            placeholder="可选，屏蔽的收件邮箱域名，多个用逗号或换行分隔。仅精确匹配完整域名，不含其子域，如：ecust.edu.cn"
            value={settings.blocked_domains}
            onChange={(e) => patchSetting({ blocked_domains: e.target.value })}
            maxLength={2000}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">精确匹配完整域名（不含子域）。例如配置 ecust.edu.cn 会屏蔽 a@ecust.edu.cn，但不会屏蔽 a@mail.ecust.edu.cn。</p>
        </div>

        <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
          <ToggleRow
            title="发送完成后通知管理员"
            description="公告邮件发送完成后，向指定管理员邮箱发送一封结果汇报邮件。"
            checked={settings.report_enabled}
            onCheckedChange={(v) => patchSetting({ report_enabled: v })}
          />
          <div className="space-y-2">
            <Label>通知邮箱</Label>
            <textarea
              className="flex min-h-16 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
              placeholder="接收汇报邮件的管理员邮箱，多个用逗号或换行分隔"
              value={settings.report_to}
              onChange={(e) => patchSetting({ report_to: e.target.value })}
              maxLength={2000}
              disabled={!settings.report_enabled}
            />
            <p className="text-xs text-[var(--color-foreground-muted)]">
              汇报内容包含计划通知数、成功、失败与额度跳过数量。需在上方至少配置一个可用发件账号。
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--color-border)] p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--color-foreground)]">失败邮件</p>
            <p className="mt-0.5 text-xs text-[var(--color-foreground-muted)]">
              向此前发送失败的用户补发公告邮件，绕过单日发送额度。点击「查看明细」可查看每封失败邮件的收件人与错误原因。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={() => void openLogs()} disabled={resending}>
              查看明细
            </Button>
            <Button variant="outline" onClick={() => void resendFailed()} disabled={resending}>
              <Send className="h-4 w-4" />
              {resending ? "重发中" : "重发失败邮件"}
            </Button>
          </div>
        </div>

        <Dialog open={logOpen} onOpenChange={setLogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>失败邮件明细</DialogTitle>
              <DialogDescription>仅显示状态为「失败」的发送记录，可在「邮件通知」设置中点击重发失败邮件进行补发。</DialogDescription>
            </DialogHeader>
            {loadingLogs ? (
              <div className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">加载中...</div>
            ) : logError ? (
              <div className="py-8 text-center text-sm text-red-500">{logError}</div>
            ) : logs.length === 0 ? (
              <div className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">没有失败的邮件记录。</div>
            ) : (
              <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                {logs.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-lg border border-[var(--color-border)] p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-[var(--color-foreground)]">
                        {row.recipientEmail}
                      </span>
                      <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-500">
                        失败
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--color-foreground-muted)]">
                      公告 #{row.announcementId}
                      {row.announcementTitle ? ` · ${row.announcementTitle}` : " · 公告已删除"}
                      {row.senderId !== null ? ` · 账号 #${row.senderId}` : ""}
                      {" · "}
                      {row.createdAt}
                    </p>
                    {row.error ? (
                      <p className="mt-1 break-words text-xs text-[var(--color-foreground-muted)]">
                        错误：{row.error}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>

        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[var(--color-foreground)]">发件账号</p>
          <Button onClick={openCreate} disabled={dialogOpen}>
            <Plus className="h-4 w-4" />
            新增发件账号
          </Button>
        </div>

        {loading ? (
          <div className="py-6 text-center text-sm text-[var(--color-foreground-muted)]">加载中...</div>
        ) : senders.length === 0 ? (
          <div className="py-6 text-center text-sm text-[var(--color-foreground-muted)]">
            暂无发件账号，邮件通知需要至少配置一个账号。
          </div>
        ) : (
          <div className="space-y-2">
            {senders.map((sender) => (
              <div
                key={sender.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <Mail className="h-4 w-4 shrink-0 text-[var(--color-foreground-muted)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-[var(--color-foreground)]">{sender.name}</span>
                    {!sender.enabled ? (
                      <span className="rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 text-xs text-[var(--color-foreground-muted)]">已停用</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-foreground-muted)]">
                    {sender.host}:{sender.port}
                    {sender.secure ? " · SSL/TLS" : " · STARTTLS"} · {sender.from_address}
                    {" · "}今日已发 {sender.sent_today}
                    {sender.daily_limit > 0 ? ` / ${sender.daily_limit}` : ""}
                    {" · "}优先级 {sender.priority}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void testSender(sender)} disabled={testingId === sender.id}>
                    <Send className="h-4 w-4" />
                    {testingId === sender.id ? "发送中" : "测试"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(sender)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void removeSender(sender)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={() => void saveSettingsNow()} disabled={savingSettings}>
            保存邮件设置
          </Button>
        </div>
      </CardContent>

      <EmailSenderDialog
        key={editorKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing !== null}
        initial={dialogInitial}
        onSave={(form) => void saveSender(form)}
        saving={savingSender}
      />
    </Card>
  );
}
